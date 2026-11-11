// The teacher layer: a classroom file a teacher writes (on disk, or at a URL the guard downloads), with base rules for every lesson and
// optional lessons a student switches between (/guard lesson). It uses the same rule language as
// guard.jsonc (see rules.ts), plus a "note" per rule that the guard shows in the teacher's words.
//
// The student's guard.jsonc turns it on with  "classroom": "<path to the file>".
// Both layers decide every tool call and the stricter answer wins (allow < ask < never), so a
// student's own rules can make a lesson stricter but never looser. Good-faith scaffolding, not
// proctoring: a student who edits the files can get around it, and the audit file shows that.
//
// {
//   "class": "Intro to Computing",
//   "version": "2026-11-11",
//   "base": { "rules": [ ... ], "dial": "...", "policy": [ "..." ] },
//   "lessons": { "1-explore": { "title": "...", "tools": ["read", "ls"], "rules": [ ... ], "dial": "...", "policy": [ ... ] } }
// }
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type Decision, type Dial, type Mode, type Rule, DIALS, dialDecision, list, matchRule, parseJsonc, parseRules, toolMatches,
} from "./rules.ts";

/** One lesson from a classroom file. */
export type Lesson = { id: string; title: string; tools?: string[]; dial?: Dial; rules: Rule[]; policy: string[] };

/** What the teacher layer says about one call; undefined fields mean the layer has no opinion. */
export type TeacherVerdict = Decision & { note?: string };

/** The rules, dial and judge policy of the base block or one lesson. */
type Layer = { rules: Rule[]; dial?: Dial; policy: string[] };

/** Everything `Classroom.load()` reads from a file. */
// Where a classroom's rules came from: a file on disk; a URL just downloaded; a URL whose server
// said the saved copy is still current; or the saved copy, because the URL couldn't be used.
export type Origin = "file" | "fetched" | "unchanged" | "cached";

type ClassroomFields = {
  spec: string; file: string; mtime: number; name: string; version: string; hash: string;
  base: Layer; lessons: Map<string, Lesson>; problems: string[]; broken: boolean; origin: Origin; fetchedAt?: string;
};

/** The dial a broken or missing classroom file falls back to, so the guard stays careful. */
const BROKEN_DIAL: Dial = "ask-before-changes";

/** How long a download of a classroom file may take before the saved copy is used instead. */
const FETCH_TIMEOUT_MS = 5000;

/** The largest classroom file accepted, in characters. Real ones are a few kilobytes. */
const MAX_FILE_CHARS = 1_000_000;

/** Hosts that may use plain http://, so a teacher can preview a file from their own computer. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A saved download: the file's text and what's needed to ask the server whether it changed. */
type Saved = { text: string; etag?: string; fetchedAt: string };

/**
 * A teacher's classroom file, read from disk or downloaded from a URL.
 *
 * Reading never throws. A file that is missing or has a mistake gives a classroom with no lessons,
 * `broken` set, and a plain-language entry in `problems`; its layer then asks before every change
 * until the file is fixed. A URL that can't be reached uses the last copy saved on this computer.
 */
export class Classroom {
  /** The path or URL as guard.jsonc wrote it, for messages. */
  readonly spec: string;
  /** Absolute path of the file, or the URL. */
  readonly file: string;
  /** When a local file was last changed, in ms; -1 if it couldn't be read, 0 for a URL. */
  readonly mtime: number;
  /** The class name, from "class". */
  readonly name: string;
  /** The teacher's version label, from "version". */
  readonly version: string;
  /** First 16 hex characters of the SHA-256 of the file's text, so the audit shows which copy was used. */
  readonly hash: string;
  /** Rules, dial and judge policy that apply in every lesson. */
  readonly base: Layer;
  /** Lessons by id, in the file's order. */
  readonly lessons: Map<string, Lesson>;
  /** Problems found while reading, in plain words. */
  readonly problems: string[];
  /** True when the file couldn't be read or parsed at all. */
  readonly broken: boolean;
  /** Where the rules came from (see Origin). */
  readonly origin: Origin;
  /** For a URL: when the copy in use was downloaded or last confirmed current (ISO time). */
  readonly fetchedAt: string | undefined;

  private constructor(f: ClassroomFields) {
    this.spec = f.spec; this.file = f.file; this.mtime = f.mtime; this.name = f.name; this.version = f.version;
    this.hash = f.hash; this.base = f.base; this.lessons = f.lessons; this.problems = f.problems; this.broken = f.broken;
    this.origin = f.origin; this.fetchedAt = f.fetchedAt;
  }

  /**
   * Whether guard.jsonc's "classroom" is a web address rather than a path.
   *
   * @param spec The value of "classroom".
   * @returns True for anything that starts like "https://".
   */
  static isUrl(spec: string): boolean {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(spec);
  }

  /**
   * Read a classroom file from disk.
   *
   * @param spec The path from guard.jsonc's "classroom"; relative paths are read from `cwd`.
   * @param cwd The folder DAVE works in.
   * @returns The classroom, or a broken one with its problem explained.
   */
  static load(spec: string, cwd: string): Classroom {
    const file = path.resolve(cwd, spec);
    let mtime: number, text: string;
    try {
      mtime = statSync(file).mtimeMs;
      text = readFileSync(file, "utf8");
    } catch {
      return Classroom.broken(spec, file, -1, `classroom file ${spec} not found, so the guard asks before every change`);
    }
    return Classroom.fromText(spec, file, text, { mtime, origin: "file" });
  }

  /**
   * Download a classroom file, keeping a copy on this computer for when the network is down.
   *
   * A saved copy is sent with its ETag, so an unchanged file isn't downloaded again. If the URL
   * can't be reached, answers with an error, or sends a file with a mistake, the saved copy is
   * used and `problems` says so. With no saved copy, the classroom is broken: ask before every change.
   *
   * @param url The URL from guard.jsonc: https://, or http:// for localhost only.
   * @param cacheDir Folder for saved copies, outside the repo.
   * @param timeoutMs How long to wait for the server.
   * @returns The classroom to use.
   */
  static async fetch(url: string, cacheDir: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Classroom> {
    const bad = Classroom.urlProblem(url);
    if (bad) return Classroom.broken(url, url, 0, bad);
    const saved = Classroom.readSaved(url, cacheDir);
    const now = new Date().toISOString();
    let res: Response;
    try {
      res = await fetch(url, { headers: saved?.etag ? { "if-none-match": saved.etag } : {}, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err: any) {
      const code = String(err?.cause?.code ?? "");
      const why = err?.name === "TimeoutError" ? `no answer in ${timeoutMs / 1000} s`
        : code === "ECONNREFUSED" ? "nothing is answering at that address"
        : code === "ENOTFOUND" ? "that address wasn't found; check the spelling, or the network is down"
        : `a network problem${code ? `: ${code}` : ""}`;
      return Classroom.fromCache(url, cacheDir, `couldn't reach the classroom file ${url} (${why})`);
    }
    if (res.url && Classroom.urlProblem(res.url)) return Classroom.fromCache(url, cacheDir, `the classroom file ${url} redirected to ${res.url}, which isn't https`);
    if (res.status === 304 && saved) {
      Classroom.writeSaved(url, cacheDir, { ...saved, fetchedAt: now });
      return Classroom.fromText(url, url, saved.text, { mtime: 0, origin: "unchanged", fetchedAt: now });
    }
    if (!res.ok) return Classroom.fromCache(url, cacheDir, `the classroom file ${url} answered ${res.status} ${res.statusText}`.trim());
    const text = await res.text();
    if (text.length > MAX_FILE_CHARS) return Classroom.fromCache(url, cacheDir, `the classroom file ${url} is over 1 MB, so it wasn't used`);
    // A new copy with a mistake doesn't replace a good saved one.
    const mistake = Classroom.mistakeIn(text);
    if (mistake && saved) return Classroom.fromCache(url, cacheDir, `the new copy of ${url} has a mistake (${mistake})`);
    const fresh = Classroom.fromText(url, url, text, { mtime: 0, origin: "fetched", fetchedAt: now });
    Classroom.writeSaved(url, cacheDir, { text, etag: res.headers.get("etag") ?? undefined, fetchedAt: now });
    return fresh;
  }

  /**
   * The saved copy of a URL's classroom file, without going to the network.
   *
   * @param url The classroom URL.
   * @param cacheDir Folder for saved copies.
   * @param why Why the saved copy is being used, shown first in `problems`; leave out when there's no problem.
   * @returns The saved classroom, or a broken one when nothing has been saved yet.
   */
  static fromCache(url: string, cacheDir: string, why?: string): Classroom {
    const saved = Classroom.readSaved(url, cacheDir);
    if (!saved) return Classroom.broken(url, url, 0, `${why ?? `the classroom file ${url} hasn't been downloaded yet`}, and there's no saved copy, so the guard asks before every change`);
    const note = why ? [`${why}; using the copy saved ${new Date(saved.fetchedAt).toLocaleString()}`] : [];
    return Classroom.fromText(url, url, saved.text, { mtime: 0, origin: "cached", fetchedAt: saved.fetchedAt }, note);
  }

  /**
   * Why a classroom URL can't be used, if it can't.
   *
   * @param url The URL to check.
   * @returns A plain-language problem, or undefined when the URL is fine.
   */
  static urlProblem(url: string): string | undefined {
    let u: URL;
    try { u = new URL(url); } catch { return `classroom "${url}" isn't a web address or a path`; }
    if (u.protocol === "https:") return undefined;
    if (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname)) return undefined;
    return `classroom "${url}" must start with https:// (http:// works only for localhost), so the guard asks before every change`;
  }

  /**
   * Build a classroom from a file's text.
   *
   * @param spec The path or URL as guard.jsonc wrote it.
   * @param file The absolute path, or the URL.
   * @param text The file's text.
   * @param from Where the text came from: its mtime, origin and download time.
   * @param problems Problems to report before any the text itself has.
   * @returns The classroom, or a broken one when the text has a mistake.
   */
  private static fromText(spec: string, file: string, text: string, from: { mtime: number; origin: Origin; fetchedAt?: string }, problems: string[] = []): Classroom {
    const mistake = Classroom.mistakeIn(text);
    if (mistake) return Classroom.broken(spec, file, from.mtime, `classroom file ${spec} has a mistake (${mistake}), so the guard asks before every change until it's fixed`, from.origin);
    const raw: any = parseJsonc(text);
    const base = Classroom.layerFrom(raw.base ?? {}, "base", problems);
    const lessons = new Map<string, Lesson>();
    const rawLessons = raw.lessons && typeof raw.lessons === "object" && !Array.isArray(raw.lessons) ? raw.lessons : {};
    if (raw.lessons !== undefined && rawLessons !== raw.lessons) problems.push(`classroom "lessons" should be a { ... } block of lessons by name; none loaded`);
    for (const [id, l] of Object.entries<any>(rawLessons)) {
      const layer = Classroom.layerFrom(l ?? {}, `lesson ${id}`, problems);
      lessons.set(id, { id, title: String(l?.title || id), tools: list(l?.tools), ...layer });
    }
    return new Classroom({
      spec, file, mtime: from.mtime, name: String(raw.class || path.basename(file)), version: String(raw.version || ""),
      hash: createHash("sha256").update(text).digest("hex").slice(0, 16), base, lessons, problems, broken: false,
      origin: from.origin, fetchedAt: from.fetchedAt,
    });
  }

  /**
   * What's wrong with a classroom file's text at the top level, if anything.
   *
   * @param text The file's text.
   * @returns The parser's message, or undefined when it holds one { ... } block.
   */
  private static mistakeIn(text: string): string | undefined {
    try {
      const raw = parseJsonc(text);
      return raw && typeof raw === "object" && !Array.isArray(raw) ? undefined : "the file should hold one { ... } block";
    } catch (err: any) {
      return err.message;
    }
  }

  /**
   * A classroom that couldn't be read: no lessons, and a careful dial until the file is fixed.
   *
   * @param spec The path or URL as written.
   * @param file The absolute path, or the URL.
   * @param mtime The file's mtime, if known.
   * @param problem What went wrong, in plain words.
   * @param origin Where the attempt came from.
   * @returns The broken classroom.
   */
  private static broken(spec: string, file: string, mtime: number, problem: string, origin: Origin = Classroom.isUrl(spec) ? "fetched" : "file"): Classroom {
    return new Classroom({
      spec, file, mtime, name: "", version: "", hash: "", base: { rules: [], dial: BROKEN_DIAL, policy: [] },
      lessons: new Map<string, Lesson>(), problems: [problem], broken: true, origin,
    });
  }

  /**
   * Paths of a URL's saved copy: the text, and a small JSON file with its ETag and download time.
   *
   * @param url The classroom URL.
   * @param cacheDir Folder for saved copies.
   * @returns Both paths, named by a hash of the URL.
   */
  private static savedPaths(url: string, cacheDir: string): { text: string; meta: string } {
    const name = createHash("sha256").update(url).digest("hex").slice(0, 16);
    return { text: path.join(cacheDir, `${name}.jsonc`), meta: path.join(cacheDir, `${name}.json`) };
  }

  /**
   * Read a URL's saved copy.
   *
   * @param url The classroom URL.
   * @param cacheDir Folder for saved copies.
   * @returns The saved copy, or undefined when there isn't a readable one.
   */
  private static readSaved(url: string, cacheDir: string): Saved | undefined {
    const p = Classroom.savedPaths(url, cacheDir);
    try {
      const meta = JSON.parse(readFileSync(p.meta, "utf8"));
      return { text: readFileSync(p.text, "utf8"), etag: meta.etag || undefined, fetchedAt: String(meta.fetchedAt) };
    } catch {
      return undefined;
    }
  }

  /**
   * Save a downloaded copy. A failure is ignored: the guard still uses the copy it downloaded,
   * and only loses the offline fallback.
   *
   * @param url The classroom URL.
   * @param cacheDir Folder for saved copies.
   * @param saved The text, ETag and download time.
   */
  private static writeSaved(url: string, cacheDir: string, saved: Saved): void {
    const p = Classroom.savedPaths(url, cacheDir);
    try {
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      writeFileSync(p.text, saved.text);
      writeFileSync(p.meta, JSON.stringify({ url, etag: saved.etag ?? null, fetchedAt: saved.fetchedAt }, null, 2));
    } catch { /* see above */ }
  }

  /**
   * Read the "rules", "dial" and "policy" of the base block or one lesson.
   *
   * @param raw The block from the file.
   * @param where "base" or "lesson <id>", for rule labels and problem messages.
   * @param problems Problems found, added to as it goes.
   * @returns The block's rules (each labelled with `where`), dial and policy.
   */
  private static layerFrom(raw: any, where: string, problems: string[]): Layer {
    const rules = raw.rules === undefined ? [] : parseRules(raw.rules, problems, `classroom ${where}: `).map((r) => ({ ...r, where }));
    let dial: Dial | undefined;
    if (raw.dial !== undefined && DIALS.includes(raw.dial)) dial = raw.dial;
    else if (raw.dial !== undefined) {
      problems.push(`classroom ${where}: dial "${raw.dial}" isn't one of ${DIALS.join(", ")}; using ${BROKEN_DIAL}`);
      dial = BROKEN_DIAL;
    }
    return { rules, dial, policy: list(raw.policy) || [] };
  }

  /**
   * The lesson with this id.
   *
   * @param id A lesson id, or undefined for none.
   * @returns The lesson, or undefined when there's no such lesson.
   */
  lesson(id: string | undefined): Lesson | undefined {
    return id === undefined ? undefined : this.lessons.get(id);
  }

  /**
   * The judge policy sentences this layer adds: the base block's, then the lesson's.
   *
   * @param lessonId The active lesson, if any.
   * @returns Plain sentences, possibly none.
   */
  policy(lessonId?: string): string[] {
    return [...this.base.policy, ...(this.lesson(lessonId)?.policy ?? [])];
  }

  /**
   * The tools the active lesson allows, as written (names or * patterns).
   *
   * @param lessonId The active lesson, if any.
   * @returns The lesson's list, or undefined when it doesn't limit tools.
   */
  tools(lessonId?: string): string[] | undefined {
    return this.lesson(lessonId)?.tools;
  }

  /**
   * A short name for this file in messages and decision sources: "Intro to Computing (v 2026-11-11)".
   *
   * @returns The label.
   */
  label(): string {
    return this.broken ? `classroom file ${this.spec}` : `${this.name}${this.version ? ` (v ${this.version})` : ""}`;
  }

  /**
   * The teacher layer's verdict on one tool call.
   *
   * Order: a tool outside the lesson's "tools" list is never allowed; then the base and lesson
   * rules (a "never" anywhere wins, otherwise the first match); then the lesson's dial, else the
   * base dial. With none of these, the layer has no opinion and the student's layer decides alone.
   *
   * @param lessonId The active lesson, if any.
   * @param toolName The tool being called.
   * @param input The call's arguments.
   * @param cwd The folder DAVE works in.
   * @param readOnly The tool's own read-only hint, when it has one.
   * @returns The verdict, or undefined when the layer has no opinion.
   */
  decide(lessonId: string | undefined, toolName: string, input: Record<string, unknown>, cwd: string, readOnly?: boolean): TeacherVerdict | undefined {
    const lesson = this.lesson(lessonId);
    const from = `${this.label()}${lesson ? `, lesson ${lesson.id}` : ""}`;
    if (lesson?.tools && !lesson.tools.some((p) => toolMatches(p, toolName))) {
      return { mode: "never", why: `use ${toolName}, which isn't part of this lesson`, source: `lesson ${lesson.id} tools in ${this.label()}`, key: `lesson-tools:${toolName}` };
    }
    const hit = matchRule([...this.base.rules, ...(lesson?.rules ?? [])], toolName, input, cwd);
    if (hit) return { mode: hit.mode, why: hit.why, note: hit.note, source: `rule ${hit.n} of ${hit.where} in ${this.label()}`, key: `teacher:${hit.where}:${hit.n}` };
    const dial = lesson?.dial ?? this.base.dial;
    if (dial) return { ...dialDecision(dial, toolName, readOnly), source: `teacher's dial "${dial}" in ${from}`, key: `teacher-dial:${toolName}` };
    return undefined;
  }

  /**
   * What the audit file records about this classroom: where it came from, which copy, and the
   * rules in force for the active lesson.
   *
   * @param lessonId The active lesson, if any.
   * @returns A plain object for JSON.
   */
  snapshot(lessonId?: string): Record<string, unknown> {
    const lesson = this.lesson(lessonId);
    return {
      file: this.file, class: this.name, version: this.version, hash: this.hash, broken: this.broken,
      origin: this.origin, fetchedAt: this.fetchedAt ?? null,
      lessons: [...this.lessons.keys()], lesson: lesson?.id ?? null, base: this.base, lessonRules: lesson ?? null,
    };
  }
}

/** How strict each mode is, for the vote between the two layers. */
const STRICTNESS: Record<Exclude<Mode, "check">, number> = { allow: 0, ask: 1, never: 2 };

/**
 * The stricter of two decisions. On a tie the teacher's wins, so its note and source are shown.
 *
 * Both must already be resolved (no "check": the judge has answered).
 *
 * @param student The student layer's decision.
 * @param teacher The teacher layer's decision, if it has one.
 * @returns The decision that applies, and which layer it came from.
 */
export function stricter(student: Decision, teacher: TeacherVerdict | undefined): { d: TeacherVerdict; layer: "student" | "teacher" } {
  if (!teacher) return { d: student, layer: "student" };
  const s = STRICTNESS[student.mode as Exclude<Mode, "check">] ?? 1;
  const t = STRICTNESS[teacher.mode as Exclude<Mode, "check">] ?? 1;
  return t >= s ? { d: teacher, layer: "teacher" } : { d: student, layer: "student" };
}
