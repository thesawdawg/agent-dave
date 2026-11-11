// The teacher layer: a classroom file a teacher writes, with base rules for every lesson and
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
import { readFileSync, statSync } from "node:fs";
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
type ClassroomFields = {
  spec: string; file: string; mtime: number; name: string; version: string; hash: string;
  base: Layer; lessons: Map<string, Lesson>; problems: string[]; broken: boolean;
};

/** The dial a broken or missing classroom file falls back to, so the guard stays careful. */
const BROKEN_DIAL: Dial = "ask-before-changes";

/**
 * A teacher's classroom file, read from disk.
 *
 * `Classroom.load()` never throws. A file that is missing or has a mistake gives a classroom with
 * no lessons, `broken` set, and a plain-language entry in `problems`; its layer then asks before
 * every change until the file is fixed.
 */
export class Classroom {
  /** The path as guard.jsonc wrote it, for messages. */
  readonly spec: string;
  /** Absolute path of the file. */
  readonly file: string;
  /** When the file was last changed, in ms; -1 if it couldn't be read. */
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

  private constructor(f: ClassroomFields) {
    this.spec = f.spec; this.file = f.file; this.mtime = f.mtime; this.name = f.name; this.version = f.version;
    this.hash = f.hash; this.base = f.base; this.lessons = f.lessons; this.problems = f.problems; this.broken = f.broken;
  }

  /**
   * Read a classroom file.
   *
   * @param spec The path from guard.jsonc's "classroom"; relative paths are read from `cwd`.
   * @param cwd The folder DAVE works in.
   * @returns The classroom, or a broken one with its problem explained.
   */
  static load(spec: string, cwd: string): Classroom {
    const file = path.resolve(cwd, spec);
    const problems: string[] = [];
    const empty = { spec, file, name: "", version: "", hash: "", base: { rules: [], dial: BROKEN_DIAL, policy: [] }, lessons: new Map<string, Lesson>(), problems, broken: true };
    let mtime: number, text: string;
    try {
      mtime = statSync(file).mtimeMs;
      text = readFileSync(file, "utf8");
    } catch {
      problems.push(`classroom file ${spec} not found, so the guard asks before every change`);
      return new Classroom({ ...empty, mtime: -1 });
    }
    let raw: any;
    try {
      raw = parseJsonc(text);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the file should hold one { ... } block");
    } catch (err: any) {
      problems.push(`classroom file ${spec} has a mistake (${err.message}), so the guard asks before every change until it's fixed`);
      return new Classroom({ ...empty, mtime });
    }

    const base = Classroom.layerFrom(raw.base ?? {}, "base", problems);
    const lessons = new Map<string, Lesson>();
    const rawLessons = raw.lessons && typeof raw.lessons === "object" && !Array.isArray(raw.lessons) ? raw.lessons : {};
    if (raw.lessons !== undefined && rawLessons !== raw.lessons) problems.push(`classroom "lessons" should be a { ... } block of lessons by name; none loaded`);
    for (const [id, l] of Object.entries<any>(rawLessons)) {
      const layer = Classroom.layerFrom(l ?? {}, `lesson ${id}`, problems);
      lessons.set(id, { id, title: String(l?.title || id), tools: list(l?.tools), ...layer });
    }
    return new Classroom({
      spec, file, mtime, name: String(raw.class || path.basename(file)), version: String(raw.version || ""),
      hash: createHash("sha256").update(text).digest("hex").slice(0, 16), base, lessons, problems, broken: false,
    });
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
