/**
 * Where DAVE's file tools may reach on Android, and the checks that keep them there.
 *
 * Termux home is always reachable. Android shared storage stays closed until the user
 * runs `/dave:android mount <folder>`; after that, home plus that one folder are the only
 * reachable places. Every path goes through realpath (the deepest existing parent for new
 * files), so `..` and symlinks such as `~/storage/shared` can't escape.
 *
 * Nothing here imports Pi, so tests can load it straight into Node.
 */
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The user's choices, saved in `<state>/config.json`. */
export type Config = { mount: string | null; allowDelete: boolean; maxReadBytes: number };

/** Whether a call only looks at a path or can change, move or remove it. */
export type Access = "read" | "write";

/** The fixed places the checks are measured against. Tests pass temporary folders. */
export type Places = {
  /** Termux home, always reachable. */
  home: string;
  /** Android shared storage, reachable only through a mount. */
  shared: string;
  /** Where config.json and hardware.json live. */
  state: string;
  /**
   * Paths no tool may change, move or delete, nor any folder that holds them: DAVE's
   * permissions, its guard rules and extensions, and Pi's own settings.
   */
  writeProtected: string[];
  /** Files no tool may even read, because they hold keys. */
  readProtected: string[];
  /**
   * Names matched anywhere in a path, as in guard.jsonc's file rules: `read` names may not be
   * read or changed (.env), `write` names may be read but not changed (.git, .ssh).
   */
  protectedNames: { read: string[]; write: string[] };
};

/** About a quarter of the smallest model's context; setup raises it to match the model it picks. */
export const DEFAULT_CONFIG: Config = { mount: null, allowDelete: false, maxReadBytes: 8_192 };

/** The places on a real device: Termux home, `/storage/emulated/0`, and DAVE's own files. */
export function defaultPlaces(): Places {
  const home = os.homedir();
  const state = path.join(home, ".dave", "android");
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  const dotPi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return {
    home,
    shared: "/storage/emulated/0",
    state,
    writeProtected: [
      state,
      agent,
      path.join(dotPi, "extensions"),
      path.join(dotPi, "lib"),
      path.join(dotPi, "guard.jsonc"),
      path.join(dotPi, "mcp.json"),
    ],
    readProtected: ["auth.json", "models.json", "guard-judge.json"].map((f) => path.join(agent, f)),
    protectedNames: { read: [".env"], write: [".git", ".ssh"] },
  };
}

/** True when `p` is `root` or sits somewhere under it. Both must already be resolved. */
export const inside = (p: string, root: string): boolean => p === root || p.startsWith(root + path.sep);

/** realpath of the deepest existing ancestor, with the missing tail re-appended. Handles new files. */
export async function realish(p: string): Promise<string> {
  let current = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...tail.reverse());
    } catch {
      const up = path.dirname(current);
      if (up === current) return p;
      tail.push(path.basename(current));
      current = up;
    }
  }
}

/** Expands `~`, `$HOME`, `$EXTERNAL_STORAGE` and `/sdcard` the way a shell user would mean them. */
function expand(places: Places, input: string): string {
  return input
    .replace(/^(~|\$HOME|\$\{HOME\})(?=$|\/)/, places.home)
    .replace(/^(\/sdcard|\/mnt\/sdcard|\$EXTERNAL_STORAGE|\$\{EXTERNAL_STORAGE\})(?=$|\/)/, places.shared);
}

/** Turns a filesystem error into something the user can act on. */
function explain(e: unknown, input: string): Error {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") {
    return new Error("Termux can't open shared storage: run termux-setup-storage and allow access, then try again");
  }
  if (code === "ENOENT") return new Error(`no such folder in shared storage: ${input}`);
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Checks a mount request and returns the folder's real path.
 * Accepts a path inside shared storage (absolute, `~/storage/...`, `/sdcard/...`) or a name
 * relative to it. Refuses anything outside shared storage, and shared storage as a whole.
 */
export async function validateMount(places: Places, input: string): Promise<string> {
  const expanded = expand(places, input.trim());
  const target = path.isAbsolute(expanded) ? expanded : path.join(places.shared, expanded);
  let shared: string, real: string;
  try {
    shared = await fs.realpath(places.shared);
    real = await fs.realpath(target);
    if (!inside(real, shared) || real === shared) throw new Error("mount must be one folder inside shared storage, not all of it");
    if (!(await fs.stat(real)).isDirectory()) throw new Error("mount must be a folder");
    await fs.access(real, constants.R_OK | constants.W_OK);
  } catch (e) {
    throw explain(e, input);
  }
  return real;
}

/** A loaded config, plus the reason a saved mount was set aside, if one was. */
export type Loaded = { config: Config; problem: string | null };

/**
 * Reads config.json. A saved mount that no longer passes validateMount is set aside, never
 * trusted, and `problem` says why so the user can be told.
 */
export async function loadConfig(places: Places): Promise<Loaded> {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(places.state, "config.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // Missing or unreadable config: start from the defaults.
  }
  let mount: string | null = null;
  let problem: string | null = null;
  if (typeof raw.mount === "string") {
    try {
      mount = await validateMount(places, raw.mount);
    } catch (e) {
      problem = `saved mount ${raw.mount} is closed for now: ${(e as Error).message}`;
    }
  }
  const n = raw.maxReadBytes;
  const maxReadBytes = typeof n === "number" && Number.isInteger(n) && n > 0 ? n : DEFAULT_CONFIG.maxReadBytes;
  return { config: { mount, allowDelete: raw.allowDelete === true, maxReadBytes }, problem };
}

/** Writes config.json, readable only by this user. */
export async function saveConfig(places: Places, config: Config): Promise<void> {
  await fs.mkdir(places.state, { recursive: true });
  const file = path.join(places.state, "config.json");
  await fs.writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/** The real paths of every reachable place: home, plus the mount when one is set. */
export async function roots(places: Places, config: Config): Promise<string[]> {
  const found = [await realish(places.home)];
  if (config.mount) found.push(await realish(config.mount));
  return found;
}

/**
 * Resolves `input` (relative to `cwd`) and returns its real path if a tool may use it that way.
 * Throws with a message the model can pass on to the user otherwise.
 */
export async function guard(
  places: Places,
  config: Config,
  input: string,
  cwd: string = places.home,
  access: Access = "read",
): Promise<string> {
  const real = await realish(path.resolve(cwd, expand(places, input)));
  const parts = real.split(path.sep);
  const names = access === "write" ? [...places.protectedNames.read, ...places.protectedNames.write] : places.protectedNames.read;
  if (names.some((n) => parts.includes(n))) throw new Error(`protected path (${names.filter((n) => parts.includes(n)).join(", ")}): ${input}`);
  for (const p of places.readProtected) {
    if (real === (await realish(p))) throw new Error(`protected DAVE/Pi path: ${input}`);
  }
  if (access === "write") {
    for (const p of places.writeProtected) {
      const guarded = await realish(p);
      if (inside(real, guarded) || inside(guarded, real)) throw new Error(`protected DAVE/Pi path: ${input}`);
    }
  }
  for (const root of await roots(places, config)) if (inside(real, root)) return real;
  throw new Error(
    config.mount
      ? `outside Termux home and the mount (${config.mount}): ${input}`
      : `outside Termux home; the user must run /dave:android mount <folder> first: ${input}`,
  );
}

/**
 * Shared-storage paths written out in a shell command: anything under `~/storage` or
 * `$HOME/storage`, `$EXTERNAL_STORAGE`, `/sdcard` and any `/storage/...` path (SD cards too).
 * Best effort only: a determined command can still get around a text check.
 */
const SHARED_REF =
  /(?<=^|[\s'"=:(<>])(?:(?:~|\$HOME|\$\{HOME\})\/storage\/|\$EXTERNAL_STORAGE|\$\{EXTERNAL_STORAGE\}|\/mnt\/sdcard|\/sdcard|\/storage\/)[^\s'";|&)]*/g;

/** Returns the first shared-storage path in `command` that the guard refuses, or null. */
export async function blockedShellRef(places: Places, config: Config, command: string): Promise<string | null> {
  if (command.includes(".dave/android")) return ".dave/android";
  for (const ref of command.match(SHARED_REF) ?? []) {
    try {
      await guard(places, config, ref);
    } catch {
      return ref;
    }
  }
  return null;
}
