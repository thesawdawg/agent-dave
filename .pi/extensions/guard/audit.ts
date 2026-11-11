// The guard's audit trail: every tool call, the guard's verdict and the rules in force, one JSON
// object per line. It's for the person using DAVE first, and for a teacher only if they share it.
//
// Where it goes: a guard-audit/ folder inside pi's session folder, named like the session file
//   ~/.pi/agent/sessions/<project>/guard-audit/<timestamp>_<session id>.jsonl
// pi lists every *.jsonl directly in the session folder as a session, so the audit file sits one
// level down and pi's own session file stays exactly as pi writes it. A session with no session
// file (pi --no-session, print mode) uses ~/.pi/agent/guard-audit/ instead. Nothing leaves this computer.
//
// Files older than "audit.keepDays" in guard.jsonc (14 days by default) are deleted at session start.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** The kinds of line an audit file holds. */
export type AuditEvent = "session" | "change" | "call" | "result";

/** One line of an audit file, as read back. */
export type AuditLine = { t: string; event: AuditEvent; [field: string]: unknown };

/** The folder name used for audit files, inside a session folder or pi's agent folder. */
export const AUDIT_DIR_NAME = "guard-audit";

/** How many days audit files are kept when guard.jsonc doesn't say. */
export const DEFAULT_KEEP_DAYS = 14;

/** Longest command or description kept per call, so one long heredoc can't swell the file. */
const MAX_WHAT = 300;

const DAY_MS = 86_400_000;

/**
 * Writes and reads one session's audit file.
 *
 * Writing never throws: the guard must keep working even if the disk is full or the folder is
 * read-only. The first failure is reported once through `onError`, and later lines are skipped.
 */
export class AuditLog {
  /** Absolute path of this session's audit file. */
  readonly file: string;
  private readonly onError: ((message: string) => void) | undefined;
  private failed = false;

  /**
   * @param file Absolute path of the audit file. Its folder is created on the first write.
   * @param onError Called once, with a plain message, if a write fails.
   */
  constructor(file: string, onError?: (message: string) => void) {
    this.file = file;
    this.onError = onError;
  }

  /**
   * Work out where a session's audit file goes.
   *
   * @param sessionFile pi's session file, or undefined when the session isn't saved.
   * @param sessionId pi's session id, used to name the file when there's no session file.
   * @param fallbackDir Folder for sessions with no session file.
   * @param now Clock, for the file name of an unsaved session.
   * @returns Absolute path of the audit file.
   */
  static pathFor(sessionFile: string | undefined, sessionId: string, fallbackDir: string, now: Date = new Date()): string {
    if (sessionFile) return path.join(path.dirname(sessionFile), AUDIT_DIR_NAME, path.basename(sessionFile));
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    return path.join(fallbackDir, `${stamp}_${sessionId}.jsonl`);
  }

  /**
   * Delete audit files last changed more than `keepDays` days ago.
   *
   * Only *.jsonl files directly inside the given folders are touched, and those folders are the
   * guard's own guard-audit/ folders. A folder that doesn't exist is skipped.
   *
   * @param dirs Audit folders to clean.
   * @param keepDays Days to keep a file after its last write.
   * @param now Clock, in milliseconds.
   * @returns How many files were deleted.
   */
  static prune(dirs: string[], keepDays: number, now: number = Date.now()): number {
    const cutoff = now - keepDays * DAY_MS;
    let removed = 0;
    for (const dir of new Set(dirs)) {
      let names: string[];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(dir, name);
        try {
          if (statSync(file).mtimeMs < cutoff) { rmSync(file); removed++; }
        } catch { /* gone already, or not ours to delete */ }
      }
    }
    return removed;
  }

  /**
   * A short, stable fingerprint of a value, so two rule sets can be compared at a glance.
   *
   * @param value Anything JSON can hold.
   * @returns The first 16 hex characters of the SHA-256 of its JSON.
   */
  static hash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  }

  /**
   * Cut a command or description to a length an audit line can carry.
   *
   * @param text The full text.
   * @param max Longest length kept.
   * @returns The text, cut with "…" when it was longer than `max`.
   */
  static shorten(text: string, max: number = MAX_WHAT): string {
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }

  /**
   * Append one line to the audit file.
   *
   * @param event What kind of line this is.
   * @param fields The line's other fields. `t` (the time) and `event` are added here.
   */
  write(event: AuditEvent, fields: Record<string, unknown>): void {
    if (this.failed) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      appendFileSync(this.file, JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + "\n", { mode: 0o600 });
    } catch (err: any) {
      this.failed = true;
      this.onError?.(`guard: couldn't write the audit file ${this.file} (${err.message}). The guard still works; this session isn't recorded.`);
    }
  }

  /**
   * Read the audit file back. A line that isn't valid JSON is skipped.
   *
   * @returns Every line, oldest first; empty if the file doesn't exist yet.
   */
  read(): AuditLine[] {
    let text: string;
    try { text = readFileSync(this.file, "utf8"); } catch { return []; }
    return text.split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line) as AuditLine]; } catch { return []; }
    });
  }

  /**
   * Count this session's calls by how the guard handled them.
   *
   * @returns Totals for all calls, calls that ran without a question, calls asked about, and calls blocked.
   */
  counts(): { calls: number; allowed: number; asked: number; blocked: number } {
    const calls = this.read().filter((l) => l.event === "call");
    return {
      calls: calls.length,
      allowed: calls.filter((l) => !AuditLog.wasAsked(l) && l.blocked !== true).length,
      asked: calls.filter(AuditLog.wasAsked).length,
      blocked: calls.filter((l) => l.blocked === true).length,
    };
  }

  /**
   * Whether a person answered a question about this call (as opposed to an automatic answer,
   * such as "auto: allowed earlier this session").
   *
   * @param line A "call" line.
   * @returns True when the guard asked and someone answered (or dismissed the question).
   */
  static wasAsked(line: AuditLine): boolean {
    return typeof line.answer === "string" && !line.answer.startsWith("auto");
  }

  /**
   * A readable summary of the audit file, for a student to hand in when a teacher asks.
   *
   * It lists each session start, every change (guard off or on, rules edited, a saved rule),
   * and a table of the calls the guard asked about or blocked. Calls that simply ran are counted, not listed.
   *
   * @returns Markdown text.
   */
  toMarkdown(): string {
    const lines = this.read();
    const when = (t: unknown) => new Date(String(t)).toLocaleString();
    const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "–";
    const out: string[] = ["# DAVE guard audit", ""];

    const starts = lines.filter((l) => l.event === "session");
    if (!starts.length) out.push("No session start was recorded in this file.", "");
    for (const s of starts) {
      out.push(`- **Session ${cell(s.reason)}** ${when(s.t)} · guard ${cell(s.guard)} · rules from ${cell(s.source)} (fingerprint \`${cell(s.hash)}\`) · dial ${cell(s.dial)}`);
    }
    out.push(`- Session id \`${cell(starts[0]?.sessionId)}\` · folder \`${cell(starts[0]?.folder)}\``, "");

    const changes = lines.filter((l) => l.event === "change");
    out.push("## Changes", "");
    if (!changes.length) out.push("None.", "");
    else out.push("| Time | Change | Detail |", "| --- | --- | --- |", ...changes.map((c) => `| ${when(c.t)} | ${cell(c.what)} | ${cell(c.detail ?? (c.hash ? `rules fingerprint ${c.hash}` : ""))} |`), "");

    const calls = lines.filter((l) => l.event === "call");
    const flagged = calls.filter((l) => l.blocked === true || AuditLog.wasAsked(l));
    const { allowed, asked, blocked } = this.counts();
    out.push("## Calls the guard asked about or blocked", "");
    if (!flagged.length) out.push("None.", "");
    else out.push("| Time | Tool | What | Verdict | Decided by | Answer |", "| --- | --- | --- | --- | --- | --- |",
      ...flagged.map((c) => `| ${when(c.t)} | ${cell(c.tool)} | ${cell(c.what)} | ${cell(c.blocked ? "blocked" : c.verdict)} | ${cell(c.by)} | ${cell(c.answer)} |`), "");
    out.push("## Totals", "", `${calls.length} tool calls: ${allowed} ran without a question, ${asked} asked about, ${blocked} blocked.`, "");
    out.push(`From \`${this.file}\`.`, "");
    return out.join("\n");
  }
}
