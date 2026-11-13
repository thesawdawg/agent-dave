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

/** The fixed places the checks are measured against. Tests pass temporary folders. */
export type Places = {
  /** Termux home, always reachable. */
  home: string;
  /** Android shared storage, reachable only through a mount. */
  shared: string;
  /** Where config.json and hardware.json live. */
  state: string;
  /** Folders and files no tool may touch, so the model can't change its own permissions. */
  protectedPaths: string[];
};

export const DEFAULT_CONFIG: Config = { mount: null, allowDelete: false, maxReadBytes: 262_144 };

/** The places on a real device: Termux home, `/storage/emulated/0`, and this extension's own files. */
export function defaultPlaces(): Places {
  const home = os.homedir();
  const state = path.join(home, ".dave", "android");
  const lib = path.dirname(fileURLToPath(import.meta.url));
  return {
    home,
    shared: "/storage/emulated/0",
    state,
    protectedPaths: [
      state,
      process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"),
      path.join(lib, "android-guard.ts"),
      path.join(lib, "android-tools.ts"),
      path.join(lib, "..", "extensions", "android.ts"),
    ],
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

/** Expands `~`, `$HOME` and `/sdcard` the way a shell user would mean them. */
function expand(places: Places, input: string): string {
  return input
    .replace(/^(~|\$HOME)(?=$|\/)/, places.home)
    .replace(/^\/sdcard(?=$|\/)/, places.shared);
}

/**
 * Checks a mount request and returns the folder's real path.
 * Accepts a path inside shared storage (absolute, `~/storage/...`, `/sdcard/...`) or a name
 * relative to it. Refuses anything outside shared storage, and shared storage as a whole.
 */
export async function validateMount(places: Places, input: string): Promise<string> {
  const expanded = expand(places, input.trim());
  const target = path.isAbsolute(expanded) ? expanded : path.join(places.shared, expanded);
  const shared = await fs.realpath(places.shared);
  const real = await fs.realpath(target);
  if (!inside(real, shared) || real === shared) {
    throw new Error("mount must be one folder inside shared storage, not all of it");
  }
  if (!(await fs.stat(real)).isDirectory()) throw new Error("mount must be a folder");
  await fs.access(real, constants.R_OK | constants.W_OK);
  return real;
}

/** Reads config.json. A saved mount that no longer passes validateMount is dropped, not trusted. */
export async function loadConfig(places: Places): Promise<Config> {
  let raw: Partial<Config> = {};
  try {
    raw = JSON.parse(await fs.readFile(path.join(places.state, "config.json"), "utf8")) as Partial<Config>;
  } catch {
    // Missing or unreadable config: start from the defaults.
  }
  const mount = typeof raw.mount === "string" ? await validateMount(places, raw.mount).catch(() => null) : null;
  const n = raw.maxReadBytes;
  const maxReadBytes = typeof n === "number" && Number.isInteger(n) && n > 0 ? n : DEFAULT_CONFIG.maxReadBytes;
  return { mount, allowDelete: raw.allowDelete === true, maxReadBytes };
}

/** Writes config.json, readable only by this user. */
export async function saveConfig(places: Places, config: Config): Promise<void> {
  await fs.mkdir(places.state, { recursive: true });
  await fs.writeFile(path.join(places.state, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** The real paths of every reachable place: home, plus the mount when one is set. */
export async function roots(places: Places, config: Config): Promise<string[]> {
  const found = [await realish(places.home)];
  if (config.mount) found.push(await realish(config.mount));
  return found;
}

/**
 * Resolves `input` (relative to `cwd`) and returns its real path if a tool may use it.
 * Throws with a message the model can pass on to the user otherwise.
 */
export async function guard(places: Places, config: Config, input: string, cwd: string = places.home): Promise<string> {
  const real = await realish(path.resolve(cwd, expand(places, input)));
  for (const p of places.protectedPaths) {
    if (inside(real, await realish(p))) throw new Error(`protected DAVE/Pi path: ${input}`);
  }
  for (const root of await roots(places, config)) if (inside(real, root)) return real;
  throw new Error(
    config.mount
      ? `outside Termux home and the mount (${config.mount}): ${input}`
      : `outside Termux home; the user must run /dave:android mount <folder> first: ${input}`,
  );
}

/**
 * Shared-storage paths written out in a shell command: the `~/storage/*` links
 * termux-setup-storage makes, `$HOME/storage/*`, `/sdcard` and `/storage/...`.
 * Best effort only: a determined command can still get around a text check.
 */
const SHARED_REF =
  /(?:(?:~|\$HOME)\/storage\/(?:shared|downloads|dcim|pictures|music|movies)|\/sdcard|\/storage\/(?:emulated\/0|self\/primary))[^\s'";|&)]*/g;

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
