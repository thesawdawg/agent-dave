// The guard's rule language: the types, reading JSONC, parsing a "rules" list, and matching one
// tool call against it. guard.jsonc (your own rules) and a teacher's classroom file share it.
import os from "node:os";
import path from "node:path";

export type Mode = "allow" | "ask" | "never" | "check";
export type Dial = "ask-before-everything" | "ask-before-changes" | "ask-before-anything-leaves" | "just-do-it";
export type Rule = { command?: string[]; exact?: boolean; file?: string[]; tool?: string[]; access: "write" | "read" | "any"; mode: Mode; why: string; n: number };
export type Decision = { mode: Mode; why: string; source: string; key: string; capped?: boolean };

export const MODES = ["allow", "ask", "never", "check"];
export const DIALS = ["ask-before-everything", "ask-before-changes", "ask-before-anything-leaves", "just-do-it"];
export const SHELLS = new Set(["bash", "powershell"]);
export const WRITES = new Set(["write", "edit"]);
export const READS = new Set(["read", "grep", "find", "ls"]);
// Tools that never change anything themselves. codemode only runs other tools, and each of those is checked too.
export const HARMLESS = new Set([...READS, "codemode", "tool_search", "ask_user_question"]);
// Words that run the command after them: sudo rm, env X=1 rm, xargs rm, timeout 5 rm ...
export const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "time", "nice", "exec", "command", "xargs", "timeout", "watch", "builtin"]);

// JSON with comments and trailing commas, the way VS Code edits it.
export function parseJsonc(text: string): unknown {
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

export const list = (v: unknown) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).map(String).filter(Boolean));

/**
 * Parse a "rules" list, the way guard.jsonc and a classroom file write it.
 *
 * A broken rule is skipped or made safer ("ask"), and each problem is added to `problems`.
 *
 * @param raw The value of "rules": should be a list.
 * @param problems Plain-language problems found, added to as it goes.
 * @param where Prefix for problem messages, such as "lesson 2-notes: ", so they say which list.
 * @returns The rules in order, numbered from 1.
 */
export function parseRules(raw: unknown, problems: string[], where = ""): Rule[] {
  const rules: Rule[] = [];
  (Array.isArray(raw) ? raw : []).forEach((r: any, i: number) => {
    const n = i + 1;
    const command = list(r?.command), file = list(r?.file), tool = list(r?.tool);
    const kinds = [command, file, tool].filter(Boolean).length;
    if (kinds !== 1) return problems.push(`${where}rule ${n}: needs exactly one of "command", "file" or "tool"; skipped`);
    let ruleMode = r.mode as Mode;
    if (!MODES.includes(String(r.mode))) {
      problems.push(`${where}rule ${n}: "mode" should be allow, ask, never or check, not "${r.mode ?? ""}"; asking to be safe`);
      ruleMode = "ask";
    }
    const access = ["write", "read", "any"].includes(r.access) ? r.access : "write";
    if (r.access !== undefined && access !== r.access) problems.push(`${where}rule ${n}: "access" must be write, read or any; using write`);
    const what = command ? `run ${command.join(" / ")}` : file ? `${access === "read" ? "read" : "change"} ${file.join(" / ")}` : `use ${tool!.join(" / ")}`;
    rules.push({ command, exact: r.exact === true && !!command, file, tool, access, mode: ruleMode, why: String(r.why || what), n });
  });
  if (!Array.isArray(raw)) problems.push(`${where}"rules" should be a list in [ ... ]; no rules loaded`);
  return rules;
}

// ---------- matching ----------
export const globRe = (glob: string, flags = "i") =>
  new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, ".").replace(/\0/g, ".*") + "$", flags);
export const baseWord = (w: string) => w.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");

// Every simple command in a command line, each as a list of words.
// "cd x && sudo rm -rf y | tee z" → [cd x] [sudo rm -rf y] [rm -rf y] [tee z]
// Quoted text is checked as a command too, so bash -c "rm x" doesn't slip past.
// The simple commands in a command line, one entry per command, each listing the ways it can be
// read (with and without sudo/env/xargs in front).
// "cd x && sudo rm -rf y | tee z" → [[cd x]] [[sudo rm -rf y], [rm -rf y]] [[tee z]]
export function commandParts(line: string): { parts: string[][][]; quoted: string[] } {
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
export function commandsIn(line: string, depth = 0): string[][] {
  const { parts, quoted } = commandParts(line);
  const out = parts.flat();
  if (depth < 3) for (const q of quoted) out.push(...commandsIn(q, depth + 1));
  return out;
}

export const squash = (s: string) => s.trim().replace(/\s+/g, " ");

// Does a command rule match this command line?
// - "exact": the whole line must equal one of the rule's commands.
// - "allow": every command in the line must be one the rule allows, so "pip install x && rm -rf ~"
//   isn't waved through by an allow rule for pip install.
// - "ask", "never", "check": any one command matching is enough.
export function commandRuleMatches(r: Rule, line: string): boolean {
  if (r.exact) return r.command!.some((p) => squash(p) === squash(line));
  if (r.mode === "allow") {
    const { parts } = commandParts(line);
    return parts.length > 0 && parts.every((variants) => variants.some((words) => r.command!.some((p) => commandMatches(p, words))));
  }
  return commandsIn(line).some((words) => r.command!.some((p) => commandMatches(p, words)));
}

export function commandMatches(pattern: string, words: string[]) {
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

export function fileMatches(pattern: string, target: string, cwd: string) {
  const flags = process.platform === "win32" ? "i" : "";
  const slash = (s: string) => s.replaceAll("\\", "/").replace(/\/+$/, "");
  const abs = slash(target);
  let p = slash(pattern.trim());
  if (!p.includes("/")) return abs.split("/").some((part) => globRe(p, flags).test(part));
  if (p.startsWith("~/")) p = slash(os.homedir()) + p.slice(1);
  else if (!path.isAbsolute(p)) p = slash(path.resolve(cwd, p));
  return globRe(p, flags).test(abs) || globRe(p + "/**", flags).test(abs);
}

export function toolMatches(pattern: string, name: string) {
  const re = globRe(pattern.replace(/[^A-Za-z0-9_*?]/g, "_"));
  return re.test(name) || re.test(name.split("__").pop()!);
}

/**
 * Find the rule that decides a tool call. A "never" rule always wins, wherever it sits;
 * otherwise the first rule that matches decides.
 *
 * @param rules The rules to check, in order.
 * @param toolName The tool being called (bash, write, an MCP tool ...).
 * @param input The tool call's arguments.
 * @param cwd The folder DAVE works in; relative paths are read from here.
 * @returns The deciding rule, or undefined when none matches.
 */
export function matchRule(rules: Rule[], toolName: string, input: Record<string, unknown>, cwd: string): Rule | undefined {
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
  for (const r of rules) if (r.mode === "never" && matches(r)) return r;
  for (const r of rules) if (matches(r)) return r;
  return undefined;
}

/**
 * What the dial says about a call no rule or setting decided.
 *
 * @param dial The dial setting.
 * @param toolName The tool being called.
 * @param readOnly The tool's own read-only hint, when it gives one (MCP tools do).
 * @returns The mode, and the words that finish "DAVE wants to ...".
 */
export function dialDecision(dial: Dial, toolName: string, readOnly?: boolean): { mode: Mode; why: string } {
  if (dial === "ask-before-everything" && toolName !== "codemode") return { mode: "ask", why: `use ${toolName}` };
  if (dial === "ask-before-changes" && !HARMLESS.has(toolName) && readOnly !== true) return { mode: "ask", why: `use ${toolName}` };
  return { mode: "allow", why: "do this" };
}
