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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type Mode = "allow" | "ask" | "never" | "check";
type JudgeLink = { url: string; model: string; apiKey: string; from: string };
type JudgeRules = { policy: string[]; allowAt: number; timeoutMs: number; coldStartMs: number; ifUnavailable: Mode; maxVerdict: "ask" | "never"; override?: JudgeLink };
type Judge = JudgeLink & JudgeRules;
type Dial = "ask-before-everything" | "ask-before-changes" | "ask-before-anything-leaves" | "just-do-it";
type Rule = { command?: string[]; exact?: boolean; file?: string[]; tool?: string[]; access: "write" | "read" | "any"; mode: Mode; why: string; n: number };
type Config = { dial: Dial; rules: Rule[]; otherCommands?: Mode; outsideThisFolder: Mode; destructiveTools: Mode; noOneToAsk: "allow" | "never"; judgeRules: JudgeRules; judge?: Judge; source: string };
type Decision = { mode: Mode; why: string; source: string; key: string; capped?: boolean };

const CONFIG = ".pi/guard.jsonc";
// The judge's connection lives outside the repo, next to pi's own models.json, so a key never lands in git.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const JUDGE_FILE = path.join(AGENT_DIR, "guard-judge.json");
const JUDGE_DEFAULTS: JudgeRules = { policy: [], allowAt: 0.8, timeoutMs: 8000, coldStartMs: 30000, ifUnavailable: "ask", maxVerdict: "never" };
// How long Ollama keeps the judge model loaded after a call. Past this, the next call loads it again.
const KEEP_ALIVE_MIN = 30;
// The background warm-up's limit. Ollama drops a half-done load when the caller hangs up,
// so the warm-up waits long enough for a slow CPU-only load to finish; nothing waits on it.
const WARM_UP_MS = 5 * 60_000;
const MODES = ["allow", "ask", "never", "check"];
const DIALS = ["ask-before-everything", "ask-before-changes", "ask-before-anything-leaves", "just-do-it"];
const SHELLS = new Set(["bash", "powershell"]);
const WRITES = new Set(["write", "edit"]);
const READS = new Set(["read", "grep", "find", "ls"]);
// Tools that never change anything themselves. codemode only runs other tools, and each of those is checked too.
const HARMLESS = new Set([...READS, "codemode", "tool_search", "ask_user_question"]);
// Words that run the command after them: sudo rm, env X=1 rm, xargs rm, timeout 5 rm ...
const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "time", "nice", "exec", "command", "xargs", "timeout", "watch", "builtin"]);

// If guard.jsonc is missing or broken, the guard doesn't switch off. It asks before every change.
const FALLBACK: Omit<Config, "source"> = {
  dial: "ask-before-changes",
  rules: [{ command: ["sudo", "doas", "su"], access: "write", mode: "never", why: "run something as administrator", n: 1 }],
  outsideThisFolder: "ask",
  destructiveTools: "ask",
  noOneToAsk: "never",
  judgeRules: JUDGE_DEFAULTS,
};

// ---------- reading guard.jsonc ----------
// JSON with comments and trailing commas, the way VS Code edits it.
function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      out += text.slice(i, end < 0 ? text.length : end + 2).replace(/[^\n]/g, " ");
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const list = (v: unknown) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).map(String).filter(Boolean));

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
  const rules: Rule[] = [];
  (Array.isArray(raw.rules) ? raw.rules : []).forEach((r: any, i: number) => {
    const n = i + 1;
    const command = list(r?.command), file = list(r?.file), tool = list(r?.tool);
    const kinds = [command, file, tool].filter(Boolean).length;
    if (kinds !== 1) return problems.push(`rule ${n}: needs exactly one of "command", "file" or "tool"; skipped`);
    let ruleMode = r.mode as Mode;
    if (!MODES.includes(String(r.mode))) {
      problems.push(`rule ${n}: "mode" should be allow, ask, never or check, not "${r.mode ?? ""}"; asking to be safe`);
      ruleMode = "ask";
    }
    const access = ["write", "read", "any"].includes(r.access) ? r.access : "write";
    if (r.access !== undefined && access !== r.access) problems.push(`rule ${n}: "access" must be write, read or any; using write`);
    const what = command ? `run ${command.join(" / ")}` : file ? `${access === "read" ? "read" : "change"} ${file.join(" / ")}` : `use ${tool!.join(" / ")}`;
    rules.push({ command, exact: r.exact === true && !!command, file, tool, access, mode: ruleMode, why: String(r.why || what), n });
  });
  if (!Array.isArray(raw.rules)) problems.push(`"rules" should be a list in [ ... ]; no rules loaded`);
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
    ifUnavailable: ifUnavailable === "never" ? "never" : "ask",
    // The strictest answer the judge may give. "ask" turns its "never" into a question for you.
    maxVerdict: j.maxVerdict === "ask" ? "ask" : "never",
    // A "url" written straight into guard.jsonc wins over the saved connection (one project, one judge).
    override: String(j.url || "").trim() ? linkFrom(j, CONFIG) : undefined,
  };
  return {
    dial,
    rules,
    otherCommands: raw.otherCommands === undefined ? undefined : mode(raw.otherCommands, "otherCommands", "ask"),
    judgeRules,
    outsideThisFolder: mode(raw.outsideThisFolder, "outsideThisFolder", "ask"),
    destructiveTools: mode(raw.destructiveTools, "destructiveTools", "ask"),
    noOneToAsk: noOne,
  };
}

// ---------- matching ----------
const globRe = (glob: string, flags = "i") =>
  new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, ".").replace(/\0/g, ".*") + "$", flags);
const baseWord = (w: string) => w.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");

// Every simple command in a command line, each as a list of words.
// "cd x && sudo rm -rf y | tee z" → [cd x] [sudo rm -rf y] [rm -rf y] [tee z]
// Quoted text is checked as a command too, so bash -c "rm x" doesn't slip past.
// The simple commands in a command line, one entry per command, each listing the ways it can be
// read (with and without sudo/env/xargs in front).
// "cd x && sudo rm -rf y | tee z" → [[cd x]] [[sudo rm -rf y], [rm -rf y]] [[tee z]]
function commandParts(line: string): { parts: string[][][]; quoted: string[] } {
  const quoted: string[] = [];
  const bare = line.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"/g, (_m, a, b) => (quoted.push(a ?? b), " _ "));
  const parts: string[][][] = [];
  for (const piece of bare.split(/\|\||&&|[;|&\n()`]|\$\(/)) {
    const all = piece.trim().split(/\s+/).filter(Boolean);
    // find ... -exec rm {} runs a second command
    const starts = [all, ...all.flatMap((w, i) => (/^-(exec|execdir|ok)$/.test(w) ? [all.slice(i + 1)] : []))];
    for (let words of starts) {
      const variants: string[][] = [];
      while (words.length) {
        variants.push(words);
        if (/^[A-Za-z_]\w*=/.test(words[0])) { words = words.slice(1); continue; }
        if (!WRAPPERS.has(baseWord(words[0]))) break;
        words = words.slice(1);
        while (words.length && /^(-|\d)/.test(words[0])) words = words.slice(1);
      }
      if (variants.length) parts.push(variants);
    }
  }
  return { parts, quoted };
}

// Every reading of every command, including text in quotes, so bash -c "rm x" doesn't slip past.
function commandsIn(line: string, depth = 0): string[][] {
  const { parts, quoted } = commandParts(line);
  const out = parts.flat();
  if (depth < 3) for (const q of quoted) out.push(...commandsIn(q, depth + 1));
  return out;
}

const squash = (s: string) => s.trim().replace(/\s+/g, " ");

// Does a command rule match this command line?
// - "exact": the whole line must equal one of the rule's commands.
// - "allow": every command in the line must be one the rule allows, so "pip install x && rm -rf ~"
//   isn't waved through by an allow rule for pip install.
// - "ask", "never", "check": any one command matching is enough.
function commandRuleMatches(r: Rule, line: string): boolean {
  if (r.exact) return r.command!.some((p) => squash(p) === squash(line));
  if (r.mode === "allow") {
    const { parts } = commandParts(line);
    return parts.length > 0 && parts.every((variants) => variants.some((words) => r.command!.some((p) => commandMatches(p, words))));
  }
  return commandsIn(line).some((words) => r.command!.some((p) => commandMatches(p, words)));
}

function commandMatches(pattern: string, words: string[]) {
  const [first, ...rest] = pattern.trim().split(/\s+/);
  if (!globRe(first.toLowerCase()).test(baseWord(words[0]))) return false;
  let at = 1;
  for (const want of rest) {
    const re = globRe(want);
    while (at < words.length && !re.test(words[at])) at++;
    if (at++ >= words.length) return false;
  }
  return true;
}

function fileMatches(pattern: string, target: string, cwd: string) {
  const flags = process.platform === "win32" ? "i" : "";
  const slash = (s: string) => s.replaceAll("\\", "/").replace(/\/+$/, "");
  const abs = slash(target);
  let p = slash(pattern.trim());
  if (!p.includes("/")) return abs.split("/").some((part) => globRe(p, flags).test(part));
  if (p.startsWith("~/")) p = slash(os.homedir()) + p.slice(1);
  else if (!path.isAbsolute(p)) p = slash(path.resolve(cwd, p));
  return globRe(p, flags).test(abs) || globRe(p + "/**", flags).test(abs);
}

function toolMatches(pattern: string, name: string) {
  const re = globRe(pattern.replace(/[^A-Za-z0-9_*?]/g, "_"));
  return re.test(name) || re.test(name.split("__").pop()!);
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

  // /guard off skips rules and the judge until /guard on or a new session; the last look still runs.
  let on = true;
  const allowed = new Set<string>(); // "Yes, for the rest of this session" answers
  const verdicts = new Map<string, { mode: Mode; detail: string }>(); // judge answers, per command, this session
  let cache: { file: string; mtime: number; judgeMtime: number; config: Config; problems: string[]; told: boolean } | undefined;

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
    }
    if (ctx?.hasUI && cache.problems.length && !cache.told) {
      cache.told = true;
      ctx.ui.notify("guard: " + cache.problems.join("\n  "), "warning");
    }
    return cache;
  }

  // Which rule or setting decides this tool call.
  function decide(config: Config, toolName: string, input: Record<string, unknown>, cwd: string): Decision {
    const rule = (r: Rule): Decision => ({ mode: r.mode, why: r.why, source: `rule ${r.n} in ${config.source}`, key: `rule:${r.n}:${r.why}` });
    const target = typeof input.path === "string" ? path.resolve(cwd, input.path) : undefined;
    const command = SHELLS.has(toolName) ? String(input.command ?? "") : undefined;
    const commands = command !== undefined ? commandsIn(command) : [];

    // Every word in the command that could be a path, so a file rule also catches "cat .env".
    const pathWords = commands.flat().flatMap((w) => w.split(/[<>=]/)).filter((w) => w && !w.startsWith("-") && w !== "_");
    const asPath = (w: string) => path.resolve(cwd, w.replace(/^~(?=[\\/]|$)/, os.homedir()));

    const matches = (r: Rule) => {
      if (r.command && command !== undefined && commandRuleMatches(r, command)) return true;
      if (r.file && command !== undefined && r.access !== "write" && pathWords.some((w) => r.file!.some((p) => fileMatches(p, asPath(w), cwd)))) return true;
      if (r.file && target) {
        const covers = r.access === "any" || (r.access === "write" ? WRITES.has(toolName) : READS.has(toolName));
        if (covers && r.file.some((p) => fileMatches(p, target, cwd))) return true;
      }
      return !!(r.tool && r.tool.some((p) => toolMatches(p, toolName)));
    };
    // "never" rules always win, wherever they sit. Otherwise the first rule that matches decides.
    for (const r of config.rules) if (r.mode === "never" && matches(r)) return rule(r);
    for (const r of config.rules) if (matches(r)) return rule(r);
    if (command !== undefined && config.otherCommands) {
      return { mode: config.otherCommands, why: "run this command", source: `otherCommands in ${config.source}`, key: `cmd:${command}` };
    }
    if (target && WRITES.has(toolName)) {
      const rel = path.relative(cwd, target);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return { mode: config.outsideThisFolder, why: "change a file outside this folder", source: `outsideThisFolder in ${config.source}`, key: "outside" };
    }
    const hints = pi.getAllTools().find((t) => t.name === toolName)?.annotations;
    if (hints?.destructiveHint === true) return { mode: config.destructiveTools, why: `use ${toolName}`, source: `destructiveTools in ${config.source}`, key: `tool:${toolName}` };

    const dial = (mode: Mode, why: string): Decision => ({ mode, why, source: `dial "${config.dial}"`, key: `dial:${toolName}` });
    if (config.dial === "ask-before-everything" && toolName !== "codemode") return dial("ask", `use ${toolName}`);
    if (config.dial === "ask-before-changes" && !HARMLESS.has(toolName) && hints?.readOnlyHint !== true) return dial("ask", `use ${toolName}`);
    if (!HARMLESS.has(toolName) && !WRITES.has(toolName) && !READS.has(toolName)) return dial("check", `use unknown tool ${toolName}`);
    return dial("allow", "do this");
  }

  // Turn a "check" decision into allow, ask or never by asking the judge.
  async function resolve(config: Config, d: Decision, toolName: string, input: Record<string, unknown>, cwd: string): Promise<Decision> {
    if (d.mode !== "check") return d;
    if (!config.judge) return { ...d, mode: "ask", source: `${d.source}; no judge connected (/guard judge setup)` };
    const call = SHELLS.has(toolName) ? { tool: toolName, command: String(input.command ?? ""), folder: cwd } : { tool: toolName, input, folder: cwd };
    const cacheKey = JSON.stringify(call);
    let v: Verdict | undefined = verdicts.get(cacheKey);
    if (!v) {
      v = await askJudge(config.judge, call);
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

  pi.on("session_start", async (_event, ctx) => {
    on = true;
    allowed.clear();
    verdicts.clear();
    const { config } = load(ctx.cwd, ctx);
    // Load the judge model now, so the first real check doesn't wait for it. It gets WARM_UP_MS, not
    // coldStartMs: cutting a load short makes Ollama throw it away, and the next call would start over.
    if (config.judge) void askJudge(config.judge, { tool: "bash", command: "ls", folder: ctx.cwd }, WARM_UP_MS);
  });

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
    ctx.ui.notify(`guard: saved rule 1 in ${CONFIG}: ${mode} ${exact ? "this exact command" : `any "${prefix}" command`}. Edit or delete it there any time.`, "info");
    return mode;
  }

  pi.on("tool_call", async (event, ctx) => {
    const verdict = on ? await gate(event, ctx) : undefined;
    if (verdict) return verdict;
    return lastLook(event, ctx);
  });

  // The last look: runs after everything else said yes (see CATASTROPHES).
  async function lastLook(event: any, ctx: any) {
    const input = (event.input ?? {}) as Record<string, unknown>;
    const what = catastropheIn(event.toolName, input, ctx.cwd);
    if (!what) return undefined;
    const reason = `guard: this would ${what}. It's on the guard's catastrophic list, so it doesn't run without the user typing RUN. Don't try another way; explain to the user what you were trying to do.`;
    if (!ctx.hasUI) return { block: true, reason };
    const choice = await ctx.ui.select(
      `guard · STOP. This could ${what}.\n\n  ${describe(event.toolName, input)}\n\nIt was allowed, but it's on the guard's list of catastrophic commands. Are you sure?`,
      ["No, block it", "I understand the risk, let me confirm"],
    );
    if (choice !== "I understand the risk, let me confirm") return { block: true, reason };
    const typed = await ctx.ui.input("Type RUN to run it. Anything else blocks it.", "");
    if ((typed || "").trim() !== "RUN") return { block: true, reason };
    return undefined;
  }

  async function gate(event: any, ctx: any) {
    const { config } = load(ctx.cwd, ctx);
    const input = (event.input ?? {}) as Record<string, unknown>;
    const d = await resolve(config, decide(config, event.toolName, input, ctx.cwd), event.toolName, input, ctx.cwd);
    const approvalKey = JSON.stringify([ctx.cwd, event.toolName, input]);
    let mode = d.mode;
    // DAVE never turns an approval requirement into implicit permission.
    if (mode === "ask" && allowed.has(approvalKey)) mode = "allow";
    if (mode === "ask" && !ctx.hasUI) mode = "never";
    if (mode === "allow") return undefined;
    if (mode === "never") {
      return { block: true, reason: `guard: DAVE may not ${d.why} (${d.source}). Don't try another way; tell the user what you wanted to do so they can decide.` };
    }
    const isShell = SHELLS.has(event.toolName);
    const choices = ["Yes, once", "Yes, for the rest of this session", "No"];
    // A call the judge flagged as dangerous can be allowed once or for the session, but not saved as "always".
    if (isShell) choices.push(...(d.capped ? [ALWAYS_BLOCK] : [ALWAYS_ALLOW, ALWAYS_BLOCK]));
    const choice = await ctx.ui.select(`guard · DAVE wants to ${d.why}:\n\n  ${describe(event.toolName, input)}\n\n  (${d.source})\n\nAllow it?`, choices);
    if (choice === ALWAYS_ALLOW || choice === ALWAYS_BLOCK) {
      const saved = await saveRuleFromPrompt(ctx, String(input.command ?? ""), choice === ALWAYS_ALLOW ? "allow" : "never", d);
      if (saved === "allow") return undefined;
      if (saved === "never") return { block: true, reason: `guard: the user blocked this for good. Don't try another way; ask the user what to do instead.` };
      // cancelled: fall through to a plain "No"
    }
    if (choice === "Yes, for the rest of this session") allowed.add(approvalKey);
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

  pi.registerCommand("guard", {
    description: "Safety interlock: show rules, /guard test <cmd>, /guard judge [setup|off], /guard off|on",
    handler: async (args, ctx) => {
      const [sub, ...restWords] = (args || "").trim().split(/\s+/);
      const rest = (args || "").trim().slice(sub.length).trim();
      const { config, problems } = load(ctx.cwd);
      const say = (s: string, level: "info" | "warning" = "info") => ctx.ui.notify(s, level);

      if (sub === "off") {
        on = false;
        return say(`guard is OFF for this session: rules in ${config.source} and the judge are skipped. The last look for catastrophic commands still runs. /guard on turns it back on.`, "warning");
      }
      if (sub === "on") {
        on = true;
        allowed.clear();
        verdicts.clear();
        return say(`guard is ON. Rules from ${config.source} apply again; session approvals and judge answers were cleared.`);
      }
      if (sub === "judge") return judgeCommand(restWords[0] || "", ctx);
      if ((sub === "test" || sub === "test-file") && restWords.length) {
        const [toolName, input] = sub === "test" ? ["bash", { command: rest }] : ["write", { path: rest }];
        const d = await resolve(config, decide(config, toolName, input, ctx.cwd), toolName, input, ctx.cwd);
        const mode = d.mode === "ask" && config.dial === "just-do-it" ? "allow (just-do-it)" : d.mode;
        const last = catastropheIn(toolName, input, ctx.cwd);
        return say(`${sub === "test" ? rest : "write " + rest}\n  → ${mode.toUpperCase()}: ${d.why}\n  decided by ${d.source}` +
          (last && mode !== "never" ? `\n  → then the LAST LOOK stops it: it could ${last}. It runs only if you type RUN.` : "") +
          (on ? "" : `\n  ! guard is OFF, so only the last look applies right now. /guard on turns the rules back on.`));
      }
      const lines = [
        `guard is ${on ? "ON" : "OFF"} · rules from ${config.source} · dial: ${config.dial}`,
        ...config.rules.map((r) => `  ${String(r.n).padStart(2)}. ${r.mode.padEnd(6)} ${r.command ? (r.exact ? "exact command" : "command") : r.file ? `file (${r.access})` : "tool"}: ${(r.command || r.file || r.tool)!.join(", ")}  · ${r.why}`),
        `  other commands: ${config.otherCommands ?? "the dial decides"} · outside this folder: ${config.outsideThisFolder} · destructive MCP tools: ${config.destructiveTools} · nobody to ask: ${config.noOneToAsk}`,
        config.judge
          ? `  judge: ${config.judge.model} at ${config.judge.url}${config.judge.apiKey ? " (with key)" : ""}, from ${config.judge.from} · allow only at ${Math.round(config.judge.allowAt * 100)}%+ · if unreachable: ${config.judge.ifUnavailable} · strictest verdict: ${config.judge.maxVerdict}`
          : `  judge: not connected. /guard judge setup connects one`,
        ...(allowed.size ? [`  allowed this session: ${[...allowed].map((k) => k.split(":").pop()).join(", ")}`] : []),
        ...problems.map((p) => `  ! ${p}`),
        `Edit ${CONFIG} to change these. Try: /guard test git push · /guard judge`,
      ];
      say(lines.join("\n"), problems.length ? "warning" : "info");
    },
  });
}
