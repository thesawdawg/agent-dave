// DAVE's safety interlock: "ask before anything leaves", enforced.
// AGENTS.md asks DAVE to check with you, and a prompt can talk a model out of that.
// This upgrade module checks every tool call before it runs, whatever the model decided.
//
// The rules live in .pi/guard.jsonc, not here: edit that file in VS Code and save.
// It's read again before every tool call, so there's nothing to reload.
// In pi: /guard, /guard test <command>, /guard test-file <path>, /guard off, /guard on.
//
// Rules catch what you expected. For the rest, a rule (or "otherCommands") can say
// mode "check": the call goes to a decision model (Clef, through Ollama's System One API),
// which answers allow, ask or never with a probability for each. See "judge" in guard.jsonc.
// The judge has its own connection, separate from the model DAVE chats with. Set it up in pi
// with /guard judge setup (or ./setup.sh --judge); it's saved to ~/.pi/agent/guard-judge.json.
//
// Every session also gets an audit file: each tool call, the verdict, who answered, and the rules
// in force, kept on this computer for "audit.keepDays" (14 by default). See audit.ts; /guard audit shows it.
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUDIT_DIR_NAME, AuditLog, DEFAULT_KEEP_DAYS } from "./audit.ts";
import { Classroom, stricter, type TeacherVerdict } from "./classroom.ts";
import {
  type Decision, type Dial, type Mode, type Rule, baseWord, commandParts, DIALS, dialDecision,
  matchRule, MODES, parseJsonc, parseRules, list, SHELLS, squash, toolMatches, WRITES,
} from "./rules.ts";

type JudgeLink = { url: string; model: string; apiKey: string; from: string };
type JudgeRules = { policy: string[]; allowAt: number; timeoutMs: number; coldStartMs: number; ifUnavailable: Mode; maxVerdict: "ask" | "never"; override?: JudgeLink };
type Judge = JudgeLink & JudgeRules;
type Config = { dial: Dial; rules: Rule[]; otherCommands?: Mode; outsideThisFolder: Mode; destructiveTools: Mode; noOneToAsk: "allow" | "never"; judgeRules: JudgeRules; judge?: Judge; keepDays: number; classroom?: string; source: string };
// What the guard did with one tool call, filled in as it decides, then written as an audit "call" line.
// "layers": with a classroom file, what each layer said on its own ("ask · rule 2 of base in ...").
type CallNote = { verdict?: Mode; by?: string; layers?: { student: string; teacher: string }; answer?: string; lastLook?: string; blocked?: boolean; error?: string };
// The guard's answer for one call: the decision that applies, which layer it came from, and each layer's own.
type Verdicts = { d: TeacherVerdict; layer: "student" | "teacher"; student: Decision; teacher?: TeacherVerdict };

const CONFIG = ".pi/guard.jsonc";
// The judge's connection lives outside the repo, next to pi's own models.json, so a key never lands in git.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const JUDGE_FILE = path.join(AGENT_DIR, "guard-judge.json");
// Saved copies of classroom files downloaded from a URL, for when the network is down.
const CLASSROOM_CACHE = path.join(AGENT_DIR, "guard-classroom");
const JUDGE_DEFAULTS: JudgeRules = { policy: [], allowAt: 0.8, timeoutMs: 8000, coldStartMs: 30000, ifUnavailable: "ask", maxVerdict: "never" };
// How long Ollama keeps the judge model loaded after a call. Past this, the next call loads it again.
const KEEP_ALIVE_MIN = 30;
// The background warm-up's limit. Ollama drops a half-done load when the caller hangs up,
// so the warm-up waits long enough for a slow CPU-only load to finish; nothing waits on it.
const WARM_UP_MS = 5 * 60_000;

// If guard.jsonc is missing or broken, the guard doesn't switch off. It asks before every change.
const FALLBACK: Omit<Config, "source"> = {
  dial: "ask-before-changes",
  rules: [{ command: ["sudo", "doas", "su"], access: "write", mode: "never", why: "run something as administrator", n: 1 }],
  outsideThisFolder: "ask",
  destructiveTools: "ask",
  noOneToAsk: "never",
  judgeRules: JUDGE_DEFAULTS,
  keepDays: DEFAULT_KEEP_DAYS,
};

// ---------- reading guard.jsonc ----------
const cleanUrl = (u: string) => u.trim().replace(/\/+$/, "").replace(/\/v1\/systemone$/, "").replace(/\/v1$/, "");
function linkFrom(j: any, from: string): JudgeLink {
  const key = String(j.apiKey || "");
  return { url: cleanUrl(String(j.url)), model: String(j.model || "clef:27b"), apiKey: key.startsWith("$") ? process.env[key.slice(1)] || "" : key, from };
}
function readJudgeFile(): JudgeLink | undefined {
  try {
    const j = JSON.parse(readFileSync(JUDGE_FILE, "utf8"));
    return String(j.url || "").trim() ? linkFrom(j, "~/.pi/agent/guard-judge.json") : undefined;
  } catch {
    return undefined;
  }
}
function saveJudgeFile(link: { url: string; model: string; apiKey: string } | undefined) {
  if (!link) return rmSync(JUDGE_FILE, { force: true });
  mkdirSync(AGENT_DIR, { recursive: true });
  writeFileSync(JUDGE_FILE, JSON.stringify(link, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(JUDGE_FILE, 0o600);
}
const mtimeOf = (f: string) => { try { return statSync(f).mtimeMs; } catch { return -1; } };

function validate(raw: any, problems: string[]): Omit<Config, "source"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the file should hold one { ... } block");
  const mode = (v: unknown, where: string, fallback: Mode): Mode => {
    if (v === undefined) return fallback;
    if (MODES.includes(String(v))) return v as Mode;
    problems.push(`${where}: "${v}" isn't allow, ask, never or check; using "${fallback}"`);
    return fallback;
  };
  let dial = (raw.dial ?? "ask-before-anything-leaves") as Dial;
  if (!DIALS.includes(dial)) {
    problems.push(`dial: "${raw.dial}" isn't one of ${DIALS.join(", ")}; using ask-before-changes`);
    dial = "ask-before-changes";
  }
  const rules = parseRules(raw.rules, problems);
  const noOne = raw.noOneToAsk === "allow" ? "allow" : "never";
  const j = raw.judge && typeof raw.judge === "object" ? raw.judge : {};
  const ifUnavailable = mode(j.ifUnavailable, "judge.ifUnavailable", "ask");
  if (j.maxVerdict !== undefined && j.maxVerdict !== "ask" && j.maxVerdict !== "never") {
    problems.push(`judge.maxVerdict: "${j.maxVerdict}" should be "ask" or "never"; using "never"`);
  }
  const timeoutMs = Number(j.timeoutMs) > 0 ? Number(j.timeoutMs) : JUDGE_DEFAULTS.timeoutMs;
  const judgeRules: JudgeRules = {
    policy: list(j.policy) || [],
    allowAt: Number.isFinite(Number(j.allowAt ?? NaN)) ? Math.min(1, Math.max(0, Number(j.allowAt))) : 0.8,
    timeoutMs,
    // A cold call loads the model first, so it gets longer. Never shorter than timeoutMs.
    coldStartMs: Math.max(timeoutMs, Number(j.coldStartMs) > 0 ? Number(j.coldStartMs) : JUDGE_DEFAULTS.coldStartMs),
    ifUnavailable: ifUnavailable === "check" ? "ask" : ifUnavailable,
    // The strictest answer the judge may give. "ask" turns its "never" into a question for you.
    maxVerdict: j.maxVerdict === "ask" ? "ask" : "never",
    // A "url" written straight into guard.jsonc wins over the saved connection (one project, one judge).
    override: String(j.url || "").trim() ? linkFrom(j, CONFIG) : undefined,
  };
  // How long audit files are kept. A whole number of days, at least 1.
  const a = raw.audit && typeof raw.audit === "object" ? raw.audit : {};
  let keepDays = DEFAULT_KEEP_DAYS;
  if (a.keepDays !== undefined) {
    if (Number.isInteger(a.keepDays) && a.keepDays >= 1) keepDays = a.keepDays;
    else problems.push(`audit.keepDays: "${a.keepDays}" should be a whole number of days, 1 or more; using ${DEFAULT_KEEP_DAYS}`);
  }
  // A teacher's classroom file: a path, relative to this folder.
  let classroom: string | undefined;
  if (typeof raw.classroom === "string" && raw.classroom.trim()) classroom = raw.classroom.trim();
  else if (raw.classroom !== undefined) problems.push(`classroom: should be the path to a classroom file, in quotes; no classroom loaded`);
  return {
    dial,
    rules,
    otherCommands: raw.otherCommands === undefined ? undefined : mode(raw.otherCommands, "otherCommands", "ask"),
    judgeRules,
    outsideThisFolder: mode(raw.outsideThisFolder, "outsideThisFolder", "ask"),
    destructiveTools: mode(raw.destructiveTools, "destructiveTools", "ask"),
    noOneToAsk: noOne,
    keepDays,
    classroom,
  };
}

// The rules as the guard understands them, for the audit file: everything that decides a call,
// and never the judge's API key.
function rulesSnapshot(config: Config): Record<string, unknown> {
  const { judge, judgeRules: { override: _override, ...judgeSettings }, ...rest } = config;
  return { ...rest, judge: judge ? { ...judgeSettings, url: judge.url, model: judge.model, from: judge.from } : null };
}

// ---------- the judge: a decision model for what no rule expected ----------
// Clef doesn't write text. It reads a "state" and typed "questions", and returns a
// probability for every allowed answer in one pass. Ollama serves it at POST /v1/systemone.
type Verdict = { mode: Mode; detail: string } | { error: string };

// Clef reads at most about 64K tokens and refuses longer input (413). Don't send what it can't read.
const MAX_STATE_CHARS = 16000;
// Ollama loads models with 4096 tokens of context unless the model sets num_ctx, and /v1/systemone
// ignores num_ctx in the request. 16384 fits MAX_STATE_CHARS of plain text plus the policy.
const MIN_JUDGE_CTX = 16384;
const ALWAYS_ALLOW = "Always allow (save a rule)";
const ALWAYS_BLOCK = "Always block (save a rule)";

// When each judge (address + model) last answered. Until it has, or once Ollama's keep_alive
// has run out, its model has to load first, so the call gets coldStartMs instead of timeoutMs.
const lastAnswered = new Map<string, number>();

/**
 * Pick the time limit for the next call to a judge.
 * @param judge The judge about to be called.
 * @returns The limit in ms (coldStartMs if the model is probably unloaded, else timeoutMs) and whether it's cold.
 */
function judgeTimeout(judge: Judge): { ms: number; cold: boolean } {
  const last = lastAnswered.get(`${judge.url} ${judge.model}`);
  const cold = last === undefined || Date.now() - last > KEEP_ALIVE_MIN * 60_000;
  return { ms: cold ? judge.coldStartMs : judge.timeoutMs, cold };
}

/**
 * Ask the decision model what should happen with one tool call.
 * @param judge The judge's connection and rules.
 * @param call The tool call, as the "state" the judge reads.
 * @param maxMs A fixed time limit in ms, instead of the cold or warm one (used by the warm-up).
 * @returns The verdict (allow, ask or never, with probabilities) or an error saying why there is none.
 */
async function askJudge(judge: Judge, call: Record<string, unknown>, maxMs?: number): Promise<Verdict> {
  if (JSON.stringify(call).length > MAX_STATE_CHARS) return { error: "the call is too long for the judge to read" };
  const limit = maxMs ? { ms: maxMs, cold: true } : judgeTimeout(judge);
  const body = {
    model: judge.model,
    keep_alive: `${KEEP_ALIVE_MIN}m`,
    state: call,
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "An AI assistant wants to make this tool call on its user's computer, in the folder named in the state. " +
          "Decide what should happen, using this policy:\n- " + (judge.policy.length ? judge.policy.join("\n- ") : "Ask before anything that deletes, publishes or sends data."),
        criteria: {
          allow: "Clearly fits the policy: reads or changes only things inside the working folder and sends nothing anywhere.",
          ask: "Might delete, overwrite, publish, install, send data off this computer or change settings, or its effect is unclear.",
          never: "Breaks the policy outright: secrets or keys, administrator rights, other people's data, or damage that can't be undone.",
        },
      },
    },
  };
  try {
    const res = await fetch(`${judge.url}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(judge.apiKey ? { authorization: `Bearer ${judge.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(limit.ms),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({})))?.error;
      const said = typeof err === "string" ? err : String(err?.message || "");
      if (res.status === 404) return { error: `the judge doesn't have ${judge.model} (ollama pull ${judge.model}, or /guard judge setup)` };
      if (res.status === 401 || res.status === 403) return { error: "the judge didn't accept its API key (/guard judge setup)" };
      if (res.status === 413) return { error: "the call is too long for the judge to read" };
      if (/context length/i.test(said)) return { error: "the call is longer than the judge's context (num_ctx); see \"The judge's context is too small\" in TROUBLESHOOTING.md" };
      return { error: `the judge answered ${res.status}${said ? `: ${said.slice(0, 120)}` : ""}` };
    }
    const answer = (await res.json())?.answers?.verdict;
    const p = answer?.probabilities || {};
    const pick = String(answer?.choice || "");
    if (!["allow", "ask", "never"].includes(pick)) return { error: "the judge's answer had no verdict" };
    lastAnswered.set(`${judge.url} ${judge.model}`, Date.now());
    const pct = (k: string) => `${k} ${Math.round(100 * (Number(p[k]) || 0))}%`;
    const detail = `${judge.model}: ${pct("allow")} · ${pct("ask")} · ${pct("never")}`;
    // A narrow "allow" isn't good enough: below allowAt, ask a person instead.
    if (pick === "allow" && (Number(p.allow) || 0) < judge.allowAt) return { mode: "ask", detail: detail + ` (allow under ${Math.round(judge.allowAt * 100)}%)` };
    return { mode: pick as Mode, detail };
  } catch (err: any) {
    return { error: err?.name === "TimeoutError" ? `the judge took longer than ${limit.ms} ms${limit.cold ? " to load (judge.coldStartMs)" : " (judge.timeoutMs)"}` : `couldn't reach the judge (${err?.cause?.code || err?.cause?.errors?.[0]?.code || err?.message || err})` };
  }
}

// ---------- the last look: catastrophic commands ----------
// Rules, the judge and your own "yes" can all be wrong. Right before a command runs, however it
// was allowed (a rule, "Yes", "Always allow", the just-do-it dial, even /guard off), it gets one more
// look against this short, fixed list of commands that can wreck a computer. A match stops and
// explains what the command would do, and runs only if you type RUN.
// This is not a complete list; it's a seat belt for the worst, most common mistakes. Add your own.
// It errs on the side of stopping: it reads the whole line, so even "echo rm -rf /" gets a second look.
type Catastrophe = { what: string; test: (line: string, cwd: string) => boolean };

// rm -r on the whole drive, your home folder or a system folder (not /tmp/x, not ~/project).
const RM_TARGETS = "(\\/|\\/\\*|~|~\\/|~\\/\\*|\\$home|\\$home\\/|\\$home\\/\\*|\\/(home|etc|usr|bin|sbin|lib|lib64|boot|var|opt|root|dev|proc|sys|system|users|library|applications|private)\\/?\\*?)";
const re = (src: string) => new RegExp(src, "i");
const CATASTROPHES: Catastrophe[] = [
  { what: "delete everything on the drive, your home folder or a system folder",
    test: (l) => re(`\\brm\\b[^;&|]*\\s-[a-z]*r[a-z]*\\b[^;&|]*\\s${RM_TARGETS}(?=\\s|$|[;&|])`).test(l) || /\brm\b.*--no-preserve-root/i.test(l) },
  { what: "delete everything in the folder it runs in, which here is your home folder or the top of the drive",
    test: (l, cwd) => isTopOrHome(cwd) && /\brm\b[^;&|]*\s-[a-z]*r[a-z]*\b[^;&|]*\s(\.|\*|\.\/\*)(?=\s|$|[;&|])/i.test(l) },
  { what: "delete every file under the top of the drive or your home folder",
    test: (l) => /\bfind\s+(\/|~|\$home)\/?\s.*(-delete\b|-exec\s+rm\b)/i.test(l) },
  { what: "delete Windows itself, or everything on drive C:",
    test: (l) => /\b(remove-item|ri|del|erase|rd|rmdir)\b.*(c:\/(windows|program files|program files \(x86\)|users)?\/?(system32\/?)?(?=["'\s]|$)|\$env:(windir|systemroot|systemdrive|userprofile)|%(windir|systemroot|systemdrive|userprofile)%)/i.test(l) },
  { what: "erase or reformat a whole disk",
    test: (l) => /\bmkfs(\.\w+)?\b|\bformat(\.com)?\s+[a-z]:|\bformat-volume\b|\bclear-disk\b|\binitialize-disk\b|\bdiskpart\b|\b(wipefs|sfdisk|fdisk|parted|sgdisk)\b.*\/dev\//i.test(l) },
  { what: "overwrite a disk directly, destroying everything on it",
    test: (l) => /\bdd\b.*\bof=\/dev\/(sd|hd|vd|xvd|nvme|disk|rdisk|mmcblk)|>\s*\/dev\/(sd|hd|vd|nvme|disk|rdisk|mmcblk)\w*|\bshred\b.*\/dev\//i.test(l) },
  { what: "start a fork bomb, which freezes the computer until it's restarted",
    test: (l) => /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*&[^}]*\}\s*;\s*:/.test(l) },
  { what: "change the owner or permissions of every file on the drive",
    test: (l) => /\b(chmod|chown|chgrp)\b\s+(-[a-z]*r[a-z]*\s+|--recursive\s+)[^;&|]*\s\/(?=\s|$|[;&|])/i.test(l) },
  { what: "move your home folder or the whole drive into nothing",
    test: (l) => /\bmv\b[^;&|]*\s(\/|~|\$home)\/?\s+\/dev\/null/i.test(l) },
  { what: "break Windows startup or delete its backups and restore points",
    test: (l) => /\bbcdedit\b.*\/(delete|deletevalue)\b|\bvssadmin\b.*delete\s+shadows|\bwmic\b.*shadowcopy\s+delete|\bcipher\b.*\/w:|\btakeown\b.*c:\/windows/i.test(l) },
  { what: "delete system-wide registry settings",
    test: (l) => /\breg(\.exe)?\s+delete\s+(hklm|hkey_local_machine)|\bremove-item\b.*\bhklm:/i.test(l) },
  { what: "overwrite the shared main branch for everyone, losing their work",
    test: (l) => /\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b)[^;&|]*\b(main|master)\b/i.test(l) },
  { what: "delete all your scheduled jobs",
    test: (l) => /\bcrontab\s+(-[a-z]*r)\b/i.test(l) },
];

function isTopOrHome(cwd: string) {
  const c = cwd.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() || "/";
  const home = os.homedir().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return c === "/" || /^[a-z]:$/.test(c) || c === home;
}

// System folders a write or edit should never land in.
const SYSTEM_DIRS = /^(\/(etc|boot|bin|sbin|usr|lib|lib64|system|dev|proc|sys)(\/|$)|[a-z]:\/windows(\/|$)|[a-z]:\/program files)/i;

// The command text as the shell will see it: Windows paths with forward slashes, quotes kept,
// and anything inside quotes looked at too (bash -c "rm -rf /").
function catastropheIn(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
  if (SHELLS.has(toolName)) {
    const line = String(input.command ?? "").replaceAll("\\", "/");
    const pieces = [line, ...[...line.matchAll(/'([^']*)'|"((?:\/.|[^"])*)"/g)].map((m) => m[1] ?? m[2])];
    for (const c of CATASTROPHES) if (pieces.some((p) => c.test(p, cwd))) return c.what;
  }
  if (WRITES.has(toolName) && typeof input.path === "string") {
    const given = input.path.replaceAll("\\", "/");
    const target = path.resolve(cwd, input.path).replaceAll("\\", "/");
    if (SYSTEM_DIRS.test(given) || SYSTEM_DIRS.test(target)) return "change a file inside the operating system's own folders";
  }
  return undefined;
}

/**
 * Read the context size a judge model loads with.
 * @param link The judge's address, key and model.
 * @returns num_ctx from the model's parameters, 0 if it sets none (Ollama's default, usually 4096), or undefined if unknown.
 */
async function judgeContext(link: JudgeLink): Promise<number | undefined> {
  try {
    const headers = { "content-type": "application/json", ...(link.apiKey ? { authorization: `Bearer ${link.apiKey}` } : {}) };
    const info = await (await fetch(`${link.url}/api/show`, { method: "POST", headers, body: JSON.stringify({ model: link.model }), signal: AbortSignal.timeout(5000) })).json();
    return Number(/^num_ctx\s+(\d+)/m.exec(String(info?.parameters || ""))?.[1] || 0);
  } catch {
    return undefined;
  }
}

/**
 * Explain a judge context that's too small for the guard's longest calls.
 * @param ctx The model's num_ctx, from judgeContext.
 * @returns A warning line, or "" when the context is big enough or unknown.
 */
function contextWarning(ctx: number | undefined): string {
  if (ctx === undefined || ctx >= MIN_JUDGE_CTX) return "";
  return `! the model loads with ${ctx || "Ollama's default (usually 4096)"} tokens of context, so long commands can be refused. ` +
    `A copy with PARAMETER num_ctx ${MIN_JUDGE_CTX} fixes it; see "The judge's context is too small" in TROUBLESHOOTING.md`;
}

// Ollama can say which of its models are decision models (capability "decision").
async function decisionModels(url: string, apiKey: string): Promise<string[]> {
  const headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  try {
    const tags = await (await fetch(`${url}/api/tags`, { headers, signal: AbortSignal.timeout(5000) })).json();
    const names: string[] = (tags?.models || []).map((m: any) => m.name || m.model).filter(Boolean).slice(0, 40);
    const shown = await Promise.all(names.map(async (name) => {
      try {
        const info = await (await fetch(`${url}/api/show`, { method: "POST", headers, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(5000) })).json();
        return (info?.capabilities || []).includes("decision") ? name : "";
      } catch { return ""; }
    }));
    return shown.filter(Boolean);
  } catch {
    return [];
  }
}

// Switch "otherCommands" in guard.jsonc, keeping its comments.
function setOtherCommands(file: string, value: Mode | undefined) {
  let text = readFileSync(file, "utf8");
  const line = /^([ \t]*)(\/\/[ \t]*)?"otherCommands"[ \t]*:[ \t]*"[a-z]*"[ \t]*,?/m;
  const want = value ? `"otherCommands": "${value}",` : `// "otherCommands": "check",`;
  if (line.test(text)) text = text.replace(line, (_m, indent) => indent + want);
  else text = text.replace(/^([ \t]*)"outsideThisFolder"/m, (_m, indent) => `${indent}${want}\n${indent}"outsideThisFolder"`);
  writeFileSync(file, text);
}

export default function (pi: ExtensionAPI) {
  let on = true;
  const allowed = new Set<string>(); // "Yes, for the rest of this session" answers
  const verdicts = new Map<string, { mode: Mode; detail: string }>(); // judge answers, per command, this session
  let cache: { file: string; mtime: number; judgeMtime: number; config: Config; problems: string[]; told: boolean } | undefined;
  let audit: AuditLog | undefined; // this session's audit file, opened at session start
  let auditedHash: string | undefined; // fingerprint of the rules last written to it
  let classroom: Classroom | undefined; // the teacher's file, when guard.jsonc names one
  let lesson: string | undefined; // the lesson picked with /guard lesson, this session
  let toolsBeforeLesson: string[] | undefined; // DAVE's tools before a lesson narrowed them, to put back after
  const seenCalls = new Set<string>(); // call ids the guard checked, so calls pi refused itself are still recorded

  // Make DAVE's tools match the lesson: exactly the tools its "tools" list names (* patterns work,
  // MCP tools too), or, with no list, the tools he had before. Returns what the list named that
  // no registered tool matched, so the teacher can fix a typo.
  function applyLessonTools(): { active?: string[]; missing: string[] } {
    const wanted = classroom?.tools(lesson);
    if (!wanted) {
      if (toolsBeforeLesson) { pi.setActiveTools(toolsBeforeLesson); toolsBeforeLesson = undefined; }
      return { missing: [] };
    }
    toolsBeforeLesson ??= pi.getActiveTools();
    const active = pi.getAllTools().map((t) => t.name).filter((n) => wanted.some((p) => toolMatches(p, n)));
    pi.setActiveTools(active);
    return { active, missing: wanted.filter((p) => !active.some((n) => toolMatches(p, n))) };
  }

  // Everything that decides a call, for the audit file: the student's rules and the teacher layer.
  const snapshot = (config: Config) => ({ ...rulesSnapshot(config), classroom: classroom?.snapshot(lesson) ?? null });

  // Write the rules to the audit file when they differ from the last ones written there:
  // guard.jsonc was edited, a rule was saved from a prompt, or the judge connection changed.
  function auditRules(config: Config, problems: string[]) {
    if (!audit) return;
    const rules = snapshot(config);
    const hash = AuditLog.hash(rules);
    if (hash === auditedHash) return;
    auditedHash = hash;
    audit.write("change", { what: "rules reloaded", source: config.source, hash, rules, problems });
  }

  function load(cwd: string, ctx?: any): { config: Config; problems: string[] } {
    const file = path.join(cwd, CONFIG);
    const mtime = mtimeOf(file);
    const judgeMtime = mtimeOf(JUDGE_FILE);
    if (!cache || cache.file !== file || cache.mtime !== mtime || cache.judgeMtime !== judgeMtime) {
      const problems: string[] = [];
      let config: Config;
      if (mtime < 0) {
        config = { ...FALLBACK, source: "built-in fallback" };
        problems.push(`${CONFIG} not found, so the guard asks before every change`);
      } else {
        try {
          config = { ...validate(parseJsonc(readFileSync(file, "utf8")), problems), source: CONFIG };
        } catch (err: any) {
          config = { ...FALLBACK, source: "built-in fallback" };
          problems.unshift(`${CONFIG} has a mistake (${err.message}), so the guard asks before every change until it's fixed`);
        }
      }
      const link = config.judgeRules.override || readJudgeFile();
      if (link) config.judge = { ...config.judgeRules, ...link };
      cache = { file, mtime, judgeMtime, config, problems, told: false };
      verdicts.clear();
      auditRules(config, problems);
    }
    if (ctx?.hasUI && cache.problems.length && !cache.told) {
      cache.told = true;
      ctx.ui.notify("guard: " + cache.problems.join("\n  "), "warning");
    }
    loadClassroom(cache.config, cwd, ctx);
    return cache;
  }

  // Read the classroom file again when guard.jsonc names a different one or the file changed.
  // Its problems are shown once per reading, and the new rules go in the audit file.
  // A file is checked on every call (it's cheap); a URL is downloaded only at session start and
  // with /guard refresh, so a slow network never slows DAVE down.
  function loadClassroom(config: Config, cwd: string, ctx?: any) {
    if (!config.classroom) {
      if (classroom) { classroom = undefined; lesson = undefined; applyLessonTools(); verdicts.clear(); auditRules(config, []); }
      return;
    }
    if (Classroom.isUrl(config.classroom)) {
      if (classroom?.spec === config.classroom) return;
      // guard.jsonc names a new URL: use its saved copy (if any) now, and download it in the background.
      // No ctx here, so nothing is shown yet: the download reports its own problems a moment later.
      useClassroom(Classroom.fromCache(config.classroom, CLASSROOM_CACHE), config);
      void refreshClassroom(config, ctx);
      return;
    }
    const file = path.resolve(cwd, config.classroom);
    if (classroom && classroom.file === file && classroom.mtime === mtimeOf(file)) return;
    useClassroom(Classroom.load(config.classroom, cwd), config, ctx);
  }

  // Switch to a newly read classroom: drop a lesson it no longer has, match DAVE's tools to the
  // lesson, forget answers given under the old rules, record the new rules, and show its problems.
  function useClassroom(next: Classroom, config: Config, ctx?: any) {
    classroom = next;
    if (lesson !== undefined && !classroom.lessons.has(lesson)) lesson = undefined;
    applyLessonTools(); // the lesson's tools list may have changed with the file
    verdicts.clear();
    auditRules(config, classroom.problems);
    if (ctx?.hasUI && classroom.problems.length) ctx.ui.notify("guard: " + classroom.problems.join("\n  "), "warning");
  }

  // Download a URL classroom file again. Only one download runs at a time; callers share it.
  let refreshing: Promise<Classroom | undefined> | undefined;
  function refreshClassroom(config: Config, ctx?: any): Promise<Classroom | undefined> {
    const url = config.classroom;
    if (!url || !Classroom.isUrl(url)) return Promise.resolve(undefined);
    refreshing ??= Classroom.fetch(url, CLASSROOM_CACHE).then((next) => {
      refreshing = undefined;
      // guard.jsonc may have changed while it downloaded; only use it if it still names this URL.
      if (cache?.config.classroom !== url) return undefined;
      useClassroom(next, cache.config, ctx);
      return next;
    });
    return refreshing;
  }

  // Which rule or setting decides this tool call.
  function decide(config: Config, toolName: string, input: Record<string, unknown>, cwd: string): Decision {
    const rule = (r: Rule): Decision => ({ mode: r.mode, why: r.why, source: `rule ${r.n} in ${config.source}`, key: `rule:${r.n}:${r.why}` });
    const hit = matchRule(config.rules, toolName, input, cwd);
    if (hit) return rule(hit);
    const target = typeof input.path === "string" ? path.resolve(cwd, input.path) : undefined;
    const command = SHELLS.has(toolName) ? String(input.command ?? "") : undefined;
    if (command !== undefined && config.otherCommands) {
      return { mode: config.otherCommands, why: "run this command", source: `otherCommands in ${config.source}`, key: `cmd:${command}` };
    }
    if (target && WRITES.has(toolName)) {
      const rel = path.relative(cwd, target);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return { mode: config.outsideThisFolder, why: "change a file outside this folder", source: `outsideThisFolder in ${config.source}`, key: "outside" };
    }
    const hints = pi.getAllTools().find((t) => t.name === toolName)?.annotations;
    if (hints?.destructiveHint === true) return { mode: config.destructiveTools, why: `use ${toolName}`, source: `destructiveTools in ${config.source}`, key: `tool:${toolName}` };
    return { ...dialDecision(config.dial, toolName, hints?.readOnlyHint), source: `dial "${config.dial}"`, key: `dial:${toolName}` };
  }

  // Turn a "check" decision into allow, ask or never by asking the judge.
  async function resolve(config: Config, d: Decision, toolName: string, input: Record<string, unknown>, cwd: string): Promise<Decision> {
    if (d.mode !== "check") return d;
    if (!config.judge) return { ...d, mode: "ask", source: `${d.source}; no judge connected (/guard judge setup)` };
    const call = SHELLS.has(toolName) ? { tool: toolName, command: String(input.command ?? ""), folder: cwd } : { tool: toolName, input, folder: cwd };
    const cacheKey = JSON.stringify(call);
    let v: Verdict | undefined = verdicts.get(cacheKey);
    if (!v) {
      // The teacher's policy sentences (base, then the lesson's) join the student's. Changing the
      // lesson or the classroom file clears the cached answers, so they never mix.
      const policy = [...config.judge.policy, ...(classroom?.policy(lesson) ?? [])];
      v = await askJudge({ ...config.judge, policy }, call);
      if (!("error" in v)) verdicts.set(cacheKey, v);
    }
    if ("error" in v) return { ...d, mode: config.judge.ifUnavailable, source: `${d.source}; ${v.error}, so judge.ifUnavailable decides` };
    // judge.maxVerdict "ask": the judge can flag a call as dangerous, but a person decides.
    // Applied here, after the answer, so it holds whatever the model does. Explicit "never" rules are separate.
    if (v.mode === "never" && config.judge.maxVerdict === "ask") {
      return { ...d, mode: "ask", capped: true, why: `${d.why} (the judge flagged it as dangerous)`, source: `${d.source}; judge says NEVER, asked instead (judge.maxVerdict) · ${v.detail}` };
    }
    return { ...d, mode: v.mode, source: `${d.source}; judge says ${v.mode.toUpperCase()} · ${v.detail}` };
  }

  const describe = (toolName: string, input: Record<string, unknown>) =>
    SHELLS.has(toolName) ? String(input.command ?? "") : typeof input.path === "string" ? `${toolName} ${input.path}` : `${toolName} ${JSON.stringify(input)}`.slice(0, 300);

  pi.on("session_start", async (event, ctx) => {
    lesson = undefined; // a lesson lasts one session; each new one starts with the base rules
    audit = undefined; // until this session's file opens, changes aren't written to the last session's
    applyLessonTools();
    const { config, problems } = load(ctx.cwd, ctx);
    // A classroom URL is downloaded once per session, before the session line records which copy is used.
    await refreshClassroom(config, ctx);
    startAudit(event.reason, config, problems, ctx);
    // Load the judge model now, so the first real check doesn't wait for it. It gets WARM_UP_MS, not
    // coldStartMs: cutting a load short makes Ollama throw it away, and the next call would start over.
    if (config.judge) void askJudge(config.judge, { tool: "bash", command: "ls", folder: ctx.cwd }, WARM_UP_MS);
  });

  // Open this session's audit file, clear out old ones, write the session line, and say so.
  // A resumed session appends to the file it already has.
  function startAudit(reason: string, config: Config, problems: string[], ctx: any) {
    const sm = ctx.sessionManager;
    const fallbackDir = path.join(AGENT_DIR, AUDIT_DIR_NAME);
    const file = AuditLog.pathFor(sm.getSessionFile(), sm.getSessionId(), fallbackDir);
    audit = new AuditLog(file, (message) => { if (ctx.hasUI) ctx.ui.notify(message, "warning"); });
    AuditLog.prune([path.dirname(file), fallbackDir], config.keepDays);
    const rules = snapshot(config);
    auditedHash = AuditLog.hash(rules);
    audit.write("session", {
      reason, sessionId: sm.getSessionId(), sessionFile: sm.getSessionFile() ?? null, folder: ctx.cwd,
      guard: on ? "on" : "off", source: config.source, dial: config.dial, hash: auditedHash, rules,
      problems: [...problems, ...(classroom?.problems ?? [])],
      classroom: classroom ? `${classroom.label()} from ${classroom.spec}` : null, lesson: lesson ?? null,
    });
    if (ctx.hasUI) {
      ctx.ui.notify(`guard: this session's tool calls are recorded in ${file}. The file stays on this computer and is deleted after ${config.keepDays} days. /guard audit shows it.`, "info");
    }
  }

  // "Always allow" / "Always block": save a rule at the top of guard.jsonc, so the answer sticks.
  async function saveRuleFromPrompt(ctx: any, command: string, mode: "allow" | "never", d: Decision): Promise<Mode | undefined> {
    const file = path.join(ctx.cwd, CONFIG);
    if (mtimeOf(file) < 0) { ctx.ui.notify(`guard: ${CONFIG} not found, so nothing was saved.`, "warning"); return undefined; }
    const line = squash(command);
    const { parts } = commandParts(line);
    // "pip install requests" → "pip install"; a lone flag or path after the program isn't part of it.
    const first = parts.length === 1 ? parts[0][parts[0].length - 1] : [];
    const prefix = first.length ? [baseWord(first[0]), ...(first[1] && /^[a-z][\w-]*$/i.test(first[1]) ? [first[1]] : [])].join(" ") : "";
    const scopes = [`Only this exact command`];
    // Saved at the top, a broad allow rule wins over the rule that asked (only "never" rules beat it). Say so.
    const overrides = mode === "allow" && d.source.startsWith("rule ") ? ` (wins over ${d.source.split(" in ")[0]}: ${d.why})` : "";
    if (prefix && prefix !== line) scopes.push(`Any command starting "${prefix}"${overrides}`);
    scopes.push("Cancel");
    const verb = mode === "allow" ? "Always allow" : "Always block";
    const scope = await ctx.ui.select(`${verb}: which commands should the new rule cover?\n\n  ${line.slice(0, 200)}`, scopes);
    if (!scope || scope === "Cancel") return undefined;
    const exact = scope.startsWith("Only");
    const by = mode === "allow" ? "allowed by you" : "blocked by you";
    const why = exact ? `run this exact command (${by})` : `run ${prefix} (${by})`;
    const rule = exact ? { command: line, exact: true, mode, why } : { command: prefix, mode, why };
    const note = `// Saved from a guard prompt on ${new Date().toLocaleDateString("en-CA")}${d.source.includes("judge says") ? ` (${d.source.split("judge says ")[1]})` : ""}`;
    const text = readFileSync(file, "utf8");
    const at = /^([ \t]*)"rules"[ \t]*:[ \t]*\[[ \t]*\r?\n/m.exec(text);
    if (!at) { ctx.ui.notify(`guard: couldn't find "rules": [ in ${CONFIG}, so nothing was saved.`, "warning"); return undefined; }
    const indent = at[1] + "  ";
    const insert = `${indent}${note}\n${indent}{ ${Object.entries(rule).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} },\n`;
    writeFileSync(file, text.slice(0, at.index + at[0].length) + insert + text.slice(at.index + at[0].length));
    audit?.write("change", { what: `rule saved: ${verb.toLowerCase()}`, detail: JSON.stringify(rule), by: "guard prompt" });
    ctx.ui.notify(`guard: saved rule 1 in ${CONFIG}: ${mode} ${exact ? "this exact command" : `any "${prefix}" command`}. Edit or delete it there any time.`, "info");
    return mode;
  }

  // Every tool call goes through here, with the guard on or off, and leaves one audit "call" line.
  pi.on("tool_call", async (event, ctx) => {
    const input = (event.input ?? {}) as Record<string, unknown>;
    const note: CallNote = on ? {} : { by: "guard off (/guard off)" };
    let result: { block: true; reason: string } | undefined;
    try {
      result = (on ? await gate(event, ctx, note) : undefined) ?? (await lastLook(event, ctx, note));
      return result;
    } catch (err: any) {
      note.error = err.message;
      throw err;
    } finally {
      seenCalls.add(event.toolCallId);
      note.blocked = !!result?.block;
      audit?.write("call", {
        id: event.toolCallId, parent: (event as any).parentToolCallId, tool: event.toolName,
        what: AuditLog.shorten(describe(event.toolName, input)), ...note,
      });
    }
  });

  // How each call ended: ran, failed, or never ran (blocked here or elsewhere). No tool output is kept.
  pi.on("tool_execution_end", async (event) => {
    // A call pi refused before the guard saw it (a tool the lesson hid, or bad arguments) still gets a call line.
    if (!seenCalls.delete(event.toolCallId)) {
      audit?.write("call", { id: event.toolCallId, tool: event.toolName, what: `${event.toolName} (refused by pi before the guard saw it)`, by: "pi: tool not available or invalid call", blocked: true });
    }
    const outcome = event.durationMs === undefined ? "not run" : event.isError ? "error" : "ok";
    audit?.write("result", { id: event.toolCallId, tool: event.toolName, outcome, ms: event.durationMs });
  });

  // Record the last look's answer after any earlier one ("Yes, once; last look: typed RUN").
  // An automatic earlier answer is replaced, so a person's answer is what the audit counts.
  function addAnswer(note: CallNote, text: string) {
    note.answer = note.answer && !note.answer.startsWith("auto") ? `${note.answer}; ${text}` : text;
  }

  // The last look: runs after everything else said yes (see CATASTROPHES).
  async function lastLook(event: any, ctx: any, note: CallNote) {
    const input = (event.input ?? {}) as Record<string, unknown>;
    const what = catastropheIn(event.toolName, input, ctx.cwd);
    if (!what) return undefined;
    note.lastLook = what;
    const reason = `guard: this would ${what}. It's on the guard's catastrophic list, so it doesn't run without the user typing RUN. Don't try another way; explain to the user what you were trying to do.`;
    if (!ctx.hasUI) { addAnswer(note, "auto: last look, nobody to type RUN"); return { block: true, reason }; }
    const choice = await ctx.ui.select(
      `guard · STOP. This could ${what}.\n\n  ${describe(event.toolName, input)}\n\nIt was allowed, but it's on the guard's list of catastrophic commands. Are you sure?`,
      ["No, block it", "I understand the risk, let me confirm"],
    );
    if (choice !== "I understand the risk, let me confirm") { addAnswer(note, `last look: ${choice ?? "dismissed"}`); return { block: true, reason }; }
    const typed = await ctx.ui.input("Type RUN to run it. Anything else blocks it.", "");
    const ran = (typed || "").trim() === "RUN";
    addAnswer(note, `last look: ${ran ? "typed RUN" : "didn't type RUN"}`);
    if (!ran) return { block: true, reason };
    return undefined;
  }

  // Both layers decide on their own (the judge answers any "check" first), then the stricter one applies.
  async function decideBoth(config: Config, toolName: string, input: Record<string, unknown>, cwd: string): Promise<Verdicts> {
    const student = await resolve(config, decide(config, toolName, input, cwd), toolName, input, cwd);
    const readOnly = pi.getAllTools().find((t) => t.name === toolName)?.annotations?.readOnlyHint;
    const asked = classroom?.decide(lesson, toolName, input, cwd, readOnly);
    const teacher = asked && (await resolve(config, asked, toolName, input, cwd));
    return { ...stricter(student, teacher), student, teacher };
  }

  async function gate(event: any, ctx: any, note: CallNote) {
    const { config } = load(ctx.cwd, ctx);
    const input = (event.input ?? {}) as Record<string, unknown>;
    const { d, layer, student, teacher } = await decideBoth(config, event.toolName, input, ctx.cwd);
    note.verdict = d.mode;
    note.by = d.source;
    if (classroom) note.layers = { student: `${student.mode} · ${student.source}`, teacher: teacher ? `${teacher.mode} · ${teacher.source}` : "no opinion" };
    const teacherNote = d.note ? `\n\n  Teacher's note: ${d.note}` : "";
    let mode = d.mode;
    // The student's just-do-it dial skips the student's own questions, never the teacher's.
    if (mode === "ask" && config.dial === "just-do-it" && layer === "student") { mode = "allow"; note.answer = "auto: just-do-it dial"; }
    if (mode === "ask" && allowed.has(d.key)) { mode = "allow"; note.answer = "auto: allowed earlier this session"; }
    if (mode === "ask" && !ctx.hasUI) { mode = config.noOneToAsk; note.answer = `auto: nobody to ask (noOneToAsk: ${mode})`; }
    if (mode === "allow") return undefined;
    if (mode === "never") {
      if (d.note && ctx.hasUI) ctx.ui.notify(`guard: blocked: ${d.why}.${teacherNote}`, "warning");
      return { block: true, reason: `guard: DAVE may not ${d.why} (${d.source}).${d.note ? ` The teacher says: ${d.note}` : ""} Don't try another way; tell the user what you wanted to do so they can decide.` };
    }
    const isShell = SHELLS.has(event.toolName);
    const choices = ["Yes, once", "Yes, for the rest of this session", "No"];
    // A call the judge flagged as dangerous can be allowed once or for the session, but not saved as "always".
    // Nor can a teacher's question: a saved allow rule is the student's, and the stricter layer would still ask.
    if (isShell) choices.push(...(d.capped || layer === "teacher" ? [ALWAYS_BLOCK] : [ALWAYS_ALLOW, ALWAYS_BLOCK]));
    const choice = await ctx.ui.select(`guard · DAVE wants to ${d.why}:\n\n  ${describe(event.toolName, input)}\n\n  (${d.source})${teacherNote}\n\nAllow it?`, choices);
    note.answer = choice ?? "dismissed";
    if (choice === ALWAYS_ALLOW || choice === ALWAYS_BLOCK) {
      const saved = await saveRuleFromPrompt(ctx, String(input.command ?? ""), choice === ALWAYS_ALLOW ? "allow" : "never", d);
      if (saved === "allow") return undefined;
      if (saved === "never") return { block: true, reason: `guard: the user blocked this for good. Don't try another way; ask the user what to do instead.` };
      // cancelled: fall through to a plain "No"
    }
    if (choice === "Yes, for the rest of this session") allowed.add(d.key);
    if (choice?.startsWith("Yes")) return undefined;
    return { block: true, reason: `guard: you said no to "${d.why}". Don't try another way; ask the user what to do instead.` };
  }

  // /guard judge [setup | off]: connect the decision model, separately from DAVE's own model.
  async function judgeCommand(action: string, ctx: any) {
    const say = (s: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(s, level);
    const file = path.join(ctx.cwd, CONFIG);
    const sample = { tool: "bash", command: "ls -la", folder: ctx.cwd };
    const probe = async (link: JudgeLink) => {
      const started = Date.now();
      const v = await askJudge({ ...JUDGE_DEFAULTS, ...link }, sample);
      return "error" in v ? `✗ ${v.error}` : `✓ answered in ${Date.now() - started} ms (ls -la → ${v.mode}; ${v.detail})`;
    };

    if (action === "off") {
      saveJudgeFile(undefined);
      audit?.write("change", { what: "judge disconnected", by: "/guard judge off" });
      const { config } = load(ctx.cwd);
      if (config.otherCommands === "check" && mtimeOf(file) >= 0) setOtherCommands(file, undefined);
      verdicts.clear();
      return say(`Judge disconnected: removed ${JUDGE_FILE}${config.judgeRules.override ? `. guard.jsonc still sets judge.url, so that judge stays on.` : "."} Commands no rule matches go back to the dial.`);
    }

    if (action === "setup") {
      const current = readJudgeFile();
      const url = cleanUrl((await ctx.ui.input("Decision model address (Ollama, port 11434):", current?.url || "http://localhost:11434")) || current?.url || "http://localhost:11434");
      if (!/^https?:\/\//i.test(url)) return say("The address should start with http:// or https://", "error");
      const keyChoice = await ctx.ui.select("Does it need an API key?", [
        "No key (local Ollama)",
        "Read it from an environment variable",
        "Type it here (it shows on screen; ./setup.sh --judge hides it)",
      ]);
      if (!keyChoice) return;
      let apiKey = "";
      if (keyChoice.startsWith("Read")) {
        const name = ((await ctx.ui.input("Environment variable name:", "JUDGE_API_KEY")) || "JUDGE_API_KEY").trim().replace(/^\$/, "");
        apiKey = "$" + name;
      } else if (keyChoice.startsWith("Type")) {
        apiKey = ((await ctx.ui.input("API key:", "")) || "").trim();
      }
      const resolvedKey = apiKey.startsWith("$") ? process.env[apiKey.slice(1)] || "" : apiKey;
      say(`Looking for decision models at ${url} …`);
      const found = await decisionModels(url, resolvedKey);
      let model = "";
      if (found.length) {
        const pick = await ctx.ui.select("Which decision model?", [...found, "Another name…"]);
        if (!pick) return;
        model = pick === "Another name…" ? "" : pick;
      }
      if (!model) model = ((await ctx.ui.input("Model name:", current?.model || "clef:27b")) || current?.model || "clef:27b").trim();

      const link = { url, model, apiKey: resolvedKey, from: JUDGE_FILE };
      const result = await probe(link);
      const ctxWarning = contextWarning(await judgeContext(link));
      if (result.startsWith("✗")) {
        const keep = await ctx.ui.select(`The judge didn't answer: ${result.slice(2)}\n\nSave it anyway?`, ["Save anyway", "Cancel"]);
        if (keep !== "Save anyway") return say("Nothing saved.", "warning");
      }
      saveJudgeFile({ url, model, apiKey });
      audit?.write("change", { what: "judge connected", detail: `${model} at ${url}`, by: "/guard judge setup" });
      verdicts.clear();
      const { config } = load(ctx.cwd);
      let routed = config.otherCommands === "check";
      if (!routed && mtimeOf(file) >= 0) {
        const yes = await ctx.ui.select("Send shell commands that no rule matches to the judge?", ["Yes, check them", "Not now (use mode \"check\" in rules yourself)"]);
        if (yes?.startsWith("Yes")) { setOtherCommands(file, "check"); routed = true; }
      }
      return say([
        `Judge connected: ${model} at ${url}${apiKey ? (apiKey.startsWith("$") ? ` (key from ${apiKey})` : " (with key)") : ""}`,
        `  ${result}`,
        ctxWarning ? `  ${ctxWarning}` : "",
        `  saved to ${JUDGE_FILE}, outside this repo; DAVE's own model connection is unchanged`,
        routed ? `  commands no rule matches now go to the judge ("otherCommands": "check")` : `  the judge decides only where a rule says "mode": "check"`,
        config.judgeRules.override ? `  ! guard.jsonc sets judge.url, which wins over this connection` : "",
        `Try: /guard test python3 -c "import os; os.remove('events.ics')"`,
      ].filter(Boolean).join("\n"));
    }

    // /guard judge: status and a live check
    const { config } = load(ctx.cwd);
    if (!config.judge) return say("No judge connected. /guard judge setup connects a decision model (an Ollama address, an optional key, and a model).");
    say(`Checking ${config.judge.model} at ${config.judge.url} …`);
    say([
      `judge: ${config.judge.model} at ${config.judge.url}${config.judge.apiKey ? " (with key)" : ""}, from ${config.judge.from}`,
      `  ${await probe(config.judge)}`,
      `  otherCommands: ${config.otherCommands ?? "not set (the dial decides)"} · allow only at ${Math.round(config.judge.allowAt * 100)}%+ · if unreachable: ${config.judge.ifUnavailable} · strictest verdict: ${config.judge.maxVerdict}`,
      `/guard judge setup changes it · /guard judge off disconnects it`,
    ].join("\n"));
  }

  // /guard audit [export]: where this session's audit file is, or a readable copy to hand in.
  function auditCommand(action: string, config: Config, ctx: any) {
    const say = (s: string, level: "info" | "warning" = "info") => ctx.ui.notify(s, level);
    if (!audit) return say("No audit file is open yet; it starts with the session.", "warning");
    if (action === "export") {
      const name = `guard-audit-${new Date().toLocaleDateString("en-CA")}-${ctx.sessionManager.getSessionId().slice(0, 8)}.md`;
      const out = path.join(ctx.cwd, name);
      writeFileSync(out, audit.toMarkdown());
      audit.write("change", { what: "audit exported", detail: out, by: "/guard audit export" });
      return say(`guard: wrote a readable copy of this session's audit to ${name}. Open it in VS Code before you share it.`);
    }
    const { calls, allowed: ran, asked, blocked } = audit.counts();
    say([
      `audit file: ${audit.file}`,
      `  ${calls} tool calls so far: ${ran} ran without a question, ${asked} asked about, ${blocked} blocked`,
      `  it stays on this computer and is deleted after ${config.keepDays} days ("audit": { "keepDays" } in ${CONFIG})`,
      `/guard audit export writes a readable copy into this folder, for handing in`,
    ].join("\n"));
  }

  // /guard lesson [<id> | none]: list the classroom file's lessons, or switch to one for this session.
  function lessonCommand(id: string, config: Config, ctx: any) {
    const say = (s: string, level: "info" | "warning" = "info") => ctx.ui.notify(s, level);
    if (!classroom) return say(`No classroom file. A teacher's file is turned on with "classroom": "<path>" in ${CONFIG}.`, "warning");
    const describeLesson = (l: { id: string; title: string; tools?: string[]; rules: unknown[] }) =>
      `${l.id === lesson ? "▸" : " "} ${l.id} · ${l.title} · ${l.rules.length} rules · tools: ${l.tools ? l.tools.join(", ") : "all"}`;
    if (!id) {
      if (!classroom.lessons.size) return say(`${classroom.label()} has no lessons; its base rules always apply.`);
      return say([`Lessons in ${classroom.label()} (now: ${lesson ?? "none, base rules only"}):`, ...[...classroom.lessons.values()].map(describeLesson),
        `/guard lesson <name> switches · /guard lesson none goes back to the base rules`].join("\n"));
    }
    const next = id === "none" ? undefined : id;
    if (next !== undefined && !classroom.lessons.has(next)) {
      return say(`No lesson "${id}" in ${classroom.label()}. Lessons: ${[...classroom.lessons.keys()].join(", ") || "none"}.`, "warning");
    }
    const before = lesson;
    lesson = next;
    // Answers given under the last lesson don't carry over: its rules and the judge's policy differ.
    allowed.clear();
    verdicts.clear();
    const { active, missing } = applyLessonTools();
    audit?.write("change", { what: "lesson switched", detail: `${before ?? "none"} → ${lesson ?? "none"}`, by: "/guard lesson" });
    auditRules(config, []);
    const l = classroom.lesson(lesson);
    say([
      l ? `Lesson ${l.id}: ${l.title}` : `No lesson: only the base rules of ${classroom.label()} apply.`,
      `  ${classroom.base.rules.length} base rules${l ? ` + ${l.rules.length} lesson rules` : ""}`,
      `  tools: ${active ? active.join(", ") || "none" : "all of DAVE's usual tools"}`,
      ...(missing.length ? [`  ! no tool matches ${missing.join(", ")} (check the spelling in ${classroom.spec})`] : []),
      `  session approvals were cleared · /guard test <command> shows how a command is decided now`,
    ].join("\n"), missing.length ? "warning" : "info");
  }

  // /guard refresh: download a classroom URL again now, instead of waiting for the next session.
  async function refreshCommand(config: Config, ctx: any) {
    const say = (s: string, level: "info" | "warning" = "info") => ctx.ui.notify(s, level);
    if (!config.classroom) return say(`No classroom file to refresh. A teacher's file is turned on with "classroom" in ${CONFIG}.`, "warning");
    if (!Classroom.isUrl(config.classroom)) return say(`The classroom file is ${config.classroom}, on this computer; the guard reads it again whenever it changes.`);
    say(`Downloading ${config.classroom} …`);
    const next = await refreshClassroom(config, ctx);
    if (!next) return;
    audit?.write("change", { what: "classroom refreshed", detail: `${next.origin} · ${next.label()} · fingerprint ${next.hash || "none"}`, by: "/guard refresh" });
    const state = { fetched: "downloaded a new copy", unchanged: "the saved copy is current", cached: "couldn't download it, so the saved copy is in use", file: "" }[next.origin];
    say(`${next.broken ? "The classroom file can't be used" : next.label()}: ${state}.${next.problems.length ? "" : " Lesson: " + (lesson ?? "none") + "."}`, next.problems.length ? "warning" : "info");
  }

  pi.registerCommand("guard", {
    description: "Safety interlock: show rules, /guard test <cmd>, /guard lesson [name], /guard refresh, /guard judge [setup|off], /guard audit [export], /guard off|on",
    handler: async (args, ctx) => {
      const [sub, ...restWords] = (args || "").trim().split(/\s+/);
      const rest = (args || "").trim().slice(sub.length).trim();
      const { config, problems } = load(ctx.cwd);
      const say = (s: string, level: "info" | "warning" = "info") => ctx.ui.notify(s, level);

      if (sub === "off") { on = false; audit?.write("change", { what: "guard off", by: "/guard off" }); return say("guard is OFF for this session: no rules, no judge. The last look at catastrophic commands still runs. /guard on turns it back on.", "warning"); }
      if (sub === "on") { on = true; allowed.clear(); verdicts.clear(); audit?.write("change", { what: "guard on", by: "/guard on" }); return say("guard is ON. Session approvals and judge answers were cleared."); }
      if (sub === "judge") return judgeCommand(restWords[0] || "", ctx);
      if (sub === "audit") return auditCommand(restWords[0] || "", config, ctx);
      if (sub === "lesson") return lessonCommand(restWords[0] || "", config, ctx);
      if (sub === "refresh") return refreshCommand(config, ctx);
      if ((sub === "test" || sub === "test-file") && restWords.length) {
        const [toolName, input] = sub === "test" ? ["bash", { command: rest }] : ["write", { path: rest }];
        const { d, layer, student, teacher } = await decideBoth(config, toolName, input, ctx.cwd);
        const mode = d.mode === "ask" && config.dial === "just-do-it" && layer === "student" ? "allow (just-do-it)" : d.mode;
        const last = catastropheIn(toolName, input, ctx.cwd);
        const layers = classroom
          ? `\n  student layer: ${student.mode} · ${student.source}\n  teacher layer: ${teacher ? `${teacher.mode} · ${teacher.source}` : "no opinion"}${d.note ? `\n  teacher's note: ${d.note}` : ""}`
          : "";
        return say(`${sub === "test" ? rest : "write " + rest}\n  → ${mode.toUpperCase()}: ${d.why}\n  decided by ${d.source}${layers}` +
          (last && mode !== "never" ? `\n  → then the LAST LOOK stops it: it could ${last}. It runs only if you type RUN.` : ""));
      }
      const lines = [
        `guard is ${on ? "ON" : "OFF"} · rules from ${config.source} · dial: ${config.dial}`,
        ...config.rules.map((r) => `  ${String(r.n).padStart(2)}. ${r.mode.padEnd(6)} ${r.command ? (r.exact ? "exact command" : "command") : r.file ? `file (${r.access})` : "tool"}: ${(r.command || r.file || r.tool)!.join(", ")}  · ${r.why}`),
        `  other commands: ${config.otherCommands ?? "the dial decides"} · outside this folder: ${config.outsideThisFolder} · destructive MCP tools: ${config.destructiveTools} · nobody to ask: ${config.noOneToAsk}`,
        config.judge
          ? `  judge: ${config.judge.model} at ${config.judge.url}${config.judge.apiKey ? " (with key)" : ""}, from ${config.judge.from} · allow only at ${Math.round(config.judge.allowAt * 100)}%+ · if unreachable: ${config.judge.ifUnavailable} · strictest verdict: ${config.judge.maxVerdict}`
          : `  judge: not connected. /guard judge setup connects one`,
        classroom
          ? `  classroom: ${classroom.label()} from ${classroom.spec}${classroom.fetchedAt ? ` (${classroom.origin === "cached" ? "saved copy" : "downloaded"} ${new Date(classroom.fetchedAt).toLocaleString()})` : ""} · ${classroom.base.rules.length} base rules · lesson: ${lesson ?? "none"} (${classroom.lessons.size} in the file) · /guard lesson`
          : `  classroom: none (add "classroom": "<path>" to ${CONFIG} to use a teacher's file)`,
        `  audit: ${audit ? audit.file : "starts with the session"} · kept ${config.keepDays} days · /guard audit`,
        ...(allowed.size ? [`  allowed this session: ${[...allowed].map((k) => k.split(":").pop()).join(", ")}`] : []),
        ...problems.map((p) => `  ! ${p}`),
        `Edit ${CONFIG} to change these. Try: /guard test git push · /guard judge`,
      ];
      say(lines.join("\n"), problems.length ? "warning" : "info");
    },
  });
}
