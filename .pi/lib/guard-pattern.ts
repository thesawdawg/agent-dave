import path from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";

export type GuardPattern = { tool: "bash" | "read" | "edit" | "write"; glob: string };

/** Validate the deliberately small, tool-specific pattern format. */
export function validPattern(value: unknown): value is GuardPattern {
  const p = value as GuardPattern | undefined;
  return !!p && ["bash", "read", "edit", "write"].includes(p.tool)
    && typeof p.glob === "string" && p.glob.length > 0 && p.glob.length <= 2000
    && !/[\r\n\0]/.test(p.glob);
}

/** Match path globs: * and ? stay within a directory; ** crosses directories. */
function globMatches(glob: string, value: string): boolean {
  let expression = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; expression += "(?:.*/)?"; }
      else expression += ".*";
    } else if (c === "*") expression += "[^/]*";
    else if (c === "?") expression += "[^/]";
    else expression += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`).test(value);
}

/** Tokenize only simple commands; compound shell syntax keeps its normal approval. */
export function simpleWords(command: string): string[] | undefined {
  if (/[;&|<>`$\\\r\n(){}#~]/.test(command)) return undefined;
  const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g);
  if (!tokens || tokens.join(" ") !== command.trim().replace(/\s+/g, " ")) return undefined;
  return tokens.map(word => /^["']/.test(word) ? word.slice(1, -1) : word);
}

/** Refuse symlink traversal, including existing ancestors of a new write target. */
function plainPath(target: string): boolean {
  let ancestor = target;
  try {
    while (!existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
    return realpathSync(ancestor) === ancestor;
  } catch { return false; }
}

/** Match the exact tool and all arguments; never approve extra shell operations. */
export function patternMatches(pattern: GuardPattern, tool: string, input: Record<string, unknown>, cwd: string): boolean {
  if (pattern.tool !== tool) return false;
  const matchPath = (glob: string, value: string): boolean => {
    const target = path.resolve(cwd, value);
    return plainPath(target) && globMatches(path.resolve(cwd, glob), target);
  };
  if (tool !== "bash") return typeof input.path === "string" && matchPath(pattern.glob, input.path);
  const wanted = simpleWords(pattern.glob), actual = simpleWords(String(input.command ?? ""));
  if (!wanted || !actual || wanted.length !== actual.length || wanted[0] !== actual[0]) return false;
  if (/[?*]/.test(wanted[0]) || actual.some(word => /[?*\[\]]/.test(word))) return false;
  return wanted.slice(1).every((word, i) => {
    const arg = actual[i + 1];
    if (word.startsWith("-")) return word === arg;
    if (arg.startsWith("-")) return false;
    return matchPath(word, arg);
  });
}

export type PatternSuggestion = { label: string; glob: string };

/** Suggest progressively broader paths while preserving the command and other arguments. */
export function recommendPatterns(tool: string, input: Record<string, unknown>, cwd: string): PatternSuggestion[] {
  const words = tool === "bash" ? simpleWords(String(input.command ?? "")) : undefined;
  let target = typeof input.path === "string" ? input.path : "";
  if (tool === "bash") {
    // These commands accept a final file operand. Avoid guessing at scripts,
    // subcommands, search expressions, or flag values in arbitrary commands.
    if (!words || words.length < 2 || !["cat", "head", "tail", "less", "more", "wc", "stat", "file", "ls"].includes(path.basename(words[0]))) return [];
    target = words[words.length - 1];
    if (!target || target.startsWith("-") || /[?*\[\]]/.test(target)) return [];
    if (words.length > 2 && words[words.length - 2].startsWith("-")) return [];
    if (!existsSync(path.resolve(cwd, target))) return [];
  }
  if (!target) return [];
  let directory = false;
  try { directory = statSync(path.resolve(cwd, target)).isDirectory(); } catch { /* New file: use its parent. */ }
  // A directory operand stays exact: broadening it would omit the pending call.
  if (directory) return [];
  const parent = path.dirname(target);
  const extension = path.extname(target);
  const candidates: PatternSuggestion[] = [];
  if (extension) candidates.push({ label: `Same file type in this directory (recommended)`, glob: path.join(parent, `*${extension}`) });
  candidates.push({ label: `Any file in this directory${extension ? "" : " (recommended)"}`, glob: path.join(parent, "*") });
  candidates.push({ label: "This directory and subdirectories (broader)", glob: path.join(parent, "**", "*") });
  const quote = (word: string): string => /\s/.test(word) ? `"${word}"` : word;
  return candidates.map(candidate => ({
    ...candidate,
    glob: words ? [...words.slice(0, -1), candidate.glob].map(quote).join(" ") : candidate.glob,
  })).filter(candidate => {
    const pattern = { tool, glob: candidate.glob };
    return validPattern(pattern) && patternMatches(pattern, tool, input, cwd);
  });
}
