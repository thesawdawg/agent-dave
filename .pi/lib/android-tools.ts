/**
 * DAVE's native file tools for Android. Every path goes through `guard`, so the tools reach
 * only Termux home and the mounted folder. Errors are thrown; Pi reports them to the model.
 * Output is capped so one call can't fill a small local model's context.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { guard, inside, roots, type Access, type Config, type Places } from "./android-guard.ts";

const run = promisify(execFile);
const text = (description: string) => Type.String({ description });

const MAX_LIST = 200;
const MAX_MATCHES = 100;
const MAX_LINE = 300;
const SEARCH_TIMEOUT_MS = 60_000;

/** What each tool body gets: the current config, a path checker, and Pi's abort signal. */
type Call = { cfg: Config; resolve: (p: string, access?: Access) => Promise<string>; signal?: AbortSignal };

/** Writes through a temp file and a rename, keeping the old file's permissions and never leaving the temp behind. */
async function writeAtomic(file: string, content: string): Promise<void> {
  const temp = `${file}.dave-tmp`;
  const mode = await fs.stat(file).then((st) => st.mode & 0o7777).catch(() => null);
  try {
    await fs.writeFile(temp, content, "utf8");
    if (mode !== null) await fs.chmod(temp, mode);
    await fs.rename(temp, file);
  } catch (e) {
    await fs.rm(temp, { force: true });
    throw e;
  }
}

/** Length of `buf[0..len)` cut back so it doesn't end partway through a UTF-8 character. */
export function utf8Boundary(buf: Buffer, len: number): number {
  let start = len;
  while (start > 0 && start > len - 4 && (buf[start - 1] & 0xc0) === 0x80) start--;
  if (start === 0) return len;
  const lead = buf[start - 1];
  const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return start - 1 + size > len ? start - 1 : len;
}

/** Caps each line so one minified file can't flood the context. */
const clip = (line: string) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);

/** Registers list_dir, read_file, write_file, edit_file, move_path, delete_path, search_files and file_info. */
export function registerAndroidTools(pi: ExtensionAPI, places: Places, config: () => Config): void {
  const tool = <S extends TSchema>(
    name: string,
    label: string,
    description: string,
    parameters: S,
    body: (args: Static<S>, call: Call) => Promise<string>,
  ): void => {
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const cfg = config();
        const resolve = (p: string, access: Access = "read") => guard(places, cfg, p, ctx.cwd, access);
        return { content: [{ type: "text", text: await body(params as Static<S>, { cfg, resolve, signal }) }], details: {} };
      },
    });
  };

  tool(
    "list_dir",
    "List",
    `List a folder: type (d folder, f file, l link), size, modified, name (first ${MAX_LIST}).`,
    Type.Object({ path: text("folder") }),
    async (a, { resolve }) => {
      const dir = await resolve(a.path);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const lines: string[] = [];
      for (const entry of entries.slice(0, MAX_LIST)) {
        const full = path.join(dir, entry.name);
        const st = await fs.stat(full).catch(() => null); // follows links, so a link to a folder reads as one
        const kind = entry.isSymbolicLink() ? "l" : entry.isDirectory() ? "d" : "f";
        // Termux's ~/storage/* are links into shared storage: show where they go, so the model can follow them.
        const target = entry.isSymbolicLink() ? ` -> ${await fs.realpath(full).catch(() => fs.readlink(full).catch(() => "?"))}${st?.isDirectory() ? "/" : ""}` : "";
        lines.push(`${kind}  ${st?.size ?? "?"}  ${st?.mtime.toISOString().slice(0, 16) ?? ""}  ${entry.name}${target}`);
      }
      if (entries.length > MAX_LIST) lines.push(`[${entries.length - MAX_LIST} more; use search_files to narrow]`);
      return lines.join("\n") || "(empty)";
    },
  );

  tool(
    "read_file",
    "Read",
    "Read a text file; large files page via offset.",
    Type.Object({ path: text("file"), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async (a, { cfg, resolve }) => {
      const offset = a.offset ?? 0;
      const handle = await fs.open(await resolve(a.path), "r");
      try {
        const buffer = Buffer.alloc(cfg.maxReadBytes);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (buffer.subarray(0, bytesRead).includes(0)) throw new Error("binary file; use file_info instead");
        const size = (await handle.stat()).size;
        const used = offset + bytesRead < size ? utf8Boundary(buffer, bytesRead) || bytesRead : bytesRead;
        const next = offset + used;
        const more = next < size ? `\n[truncated; next offset ${next} of ${size}]` : "";
        return buffer.subarray(0, used).toString("utf8") + more;
      } finally {
        await handle.close();
      }
    },
  );

  tool(
    "write_file",
    "Write",
    "Create or overwrite a file (atomic).",
    Type.Object({ path: text("file"), content: text("full text") }),
    async (a, { resolve }) => {
      const file = await resolve(a.path, "write");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeAtomic(file, a.content);
      return `wrote ${Buffer.byteLength(a.content)} bytes to ${file}`;
    },
  );

  tool(
    "edit_file",
    "Edit",
    "Replace exactly one occurrence of old_text (atomic).",
    Type.Object({ path: text("file"), old_text: text("text to find, must match once"), new_text: text("replacement") }),
    async (a, { resolve }) => {
      const file = await resolve(a.path, "write");
      const source = await fs.readFile(file, "utf8");
      const matches = a.old_text ? source.split(a.old_text).length - 1 : 0;
      if (matches !== 1) throw new Error(`old_text matched ${matches} times; it must match exactly once`);
      await writeAtomic(file, source.replace(a.old_text, () => a.new_text));
      return `edited ${file}`;
    },
  );

  tool(
    "move_path",
    "Move",
    "Move or rename within the allowed areas.",
    Type.Object({ from: text("source"), to: text("destination") }),
    async (a, { cfg, resolve }) => {
      const from = await resolve(a.from, "write");
      const to = await resolve(a.to, "write");
      if ((await roots(places, cfg)).includes(from)) throw new Error("refusing to move Termux home or the mount itself");
      // Overwriting would delete the destination, which needs delete_path's switch.
      if (await fs.lstat(to).then(() => true, () => false)) throw new Error(`destination exists: ${a.to}; pick a new name`);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to).catch(async (e: NodeJS.ErrnoException) => {
        if (e.code !== "EXDEV") throw e;
        // Home and shared storage are different filesystems: copy, then remove the original.
        await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
        await fs.rm(from, { recursive: true });
      });
      return `moved ${from} -> ${to}`;
    },
  );

  tool(
    "delete_path",
    "Delete",
    "Delete a file or folder; off unless the user runs /dave:android delete on.",
    Type.Object({ path: text("target"), recursive: Type.Optional(Type.Boolean()) }),
    async (a, { cfg, resolve }) => {
      if (!cfg.allowDelete) throw new Error("delete is off; the user can enable it with /dave:android delete on");
      const target = await resolve(a.path, "write");
      if ((await roots(places, cfg)).includes(target)) throw new Error("refusing to delete Termux home or the mount itself");
      await fs.rm(target, { recursive: a.recursive === true });
      return `deleted ${target}`;
    },
  );

  tool(
    "search_files",
    "Search",
    "ripgrep: mode 'content' (regex) or 'name' (glob).",
    Type.Object({ path: text("folder"), pattern: text("regex or glob"), mode: Type.Optional(text("content | name")) }),
    async (a, { cfg, resolve, signal }) => {
      const dir = await resolve(a.path);
      const args = a.mode === "name" ? ["--files", "-g", a.pattern, dir] : ["-n", "--max-count", "5", "-e", a.pattern, dir];
      const { stdout } = await run("rg", args, { maxBuffer: 4 << 20, timeout: SEARCH_TIMEOUT_MS, signal }).catch(
        (e: { code?: number | string; stdout?: string; killed?: boolean }) => {
          if (signal?.aborted) throw new Error("search cancelled");
          // rg exits 1 for "no matches" and 2 when some files were unreadable; a timeout or full buffer keeps what it found.
          if (e.stdout || e.code === 1) return { stdout: e.stdout ?? "" };
          if (e.killed) throw new Error(`search stopped after ${SEARCH_TIMEOUT_MS / 1000}s with no matches; narrow the folder`);
          throw e;
        },
      );
      const lines = stdout.split("\n").filter(Boolean);
      // Searches don't follow links, so searching home never reaches the mount: say where it is.
      const mountHint = cfg.mount && !inside(dir, cfg.mount) ? ` (the mounted folder ${cfg.mount} is outside this search; search it directly)` : "";
      if (!lines.length) return `no matches${mountHint}`;
      return lines.slice(0, MAX_MATCHES).map(clip).join("\n") + (lines.length > MAX_MATCHES ? `\n[${lines.length - MAX_MATCHES} more]` : "");
    },
  );

  tool("file_info", "Info", "Size, times and MIME type.", Type.Object({ path: text("path") }), async (a, { resolve, signal }) => {
    const target = await resolve(a.path);
    const st = await fs.stat(target);
    const { stdout } = await run("file", ["-b", "--mime-type", target], { timeout: 10_000, signal }).catch(() => ({ stdout: "unknown" }));
    return JSON.stringify({ path: target, dir: st.isDirectory(), size: st.size, modified: st.mtime, mime: stdout.trim() }, null, 2);
  });
}
