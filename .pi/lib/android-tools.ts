/**
 * DAVE's native file tools for Android. Every path goes through `guard`, so the tools reach
 * only Termux home and the mounted folder. Errors are thrown; Pi reports them to the model.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { guard, roots, type Config, type Places } from "./android-guard.ts";

const run = promisify(execFile);
const text = (description: string) => Type.String({ description });

/** Writes through a temp file and a rename, so a crash never leaves a half-written file. */
async function writeAtomic(file: string, content: string): Promise<void> {
  const temp = `${file}.dave-tmp`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, file);
}

/** Registers list_dir, read_file, write_file, edit_file, move_path, delete_path, search_files and file_info. */
export function registerAndroidTools(pi: ExtensionAPI, places: Places, config: () => Config): void {
  const tool = <S extends TSchema>(
    name: string,
    label: string,
    description: string,
    parameters: S,
    body: (args: Static<S>, cfg: Config, resolve: (p: string) => Promise<string>) => Promise<string>,
  ): void => {
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const cfg = config();
        const resolve = (p: string) => guard(places, cfg, p, ctx.cwd);
        return { content: [{ type: "text", text: await body(params as Static<S>, cfg, resolve) }], details: {} };
      },
    });
  };

  tool("list_dir", "List", "List a folder: type, size, modified, name.", Type.Object({ path: text("folder") }), async (a, _c, resolve) => {
    const dir = await resolve(a.path);
    const lines: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const st = await fs.stat(path.join(dir, entry.name)).catch(() => null);
      lines.push(`${entry.isDirectory() ? "d" : "f"}  ${st?.size ?? "?"}  ${st?.mtime.toISOString().slice(0, 16) ?? ""}  ${entry.name}`);
    }
    return lines.join("\n") || "(empty)";
  });

  tool(
    "read_file",
    "Read",
    "Read a text file; large files page via offset.",
    Type.Object({ path: text("file"), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async (a, c, resolve) => {
      const offset = a.offset ?? 0;
      const handle = await fs.open(await resolve(a.path), "r");
      try {
        const buffer = Buffer.alloc(c.maxReadBytes);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        const size = (await handle.stat()).size;
        const next = offset + bytesRead;
        const more = next < size ? `\n[truncated; next offset ${next} of ${size}]` : "";
        return buffer.subarray(0, bytesRead).toString("utf8") + more;
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
    async (a, _c, resolve) => {
      const file = await resolve(a.path);
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
    async (a, _c, resolve) => {
      const file = await resolve(a.path);
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
    async (a, c, resolve) => {
      const from = await resolve(a.from);
      const to = await resolve(a.to);
      if ((await roots(places, c)).includes(from)) throw new Error("refusing to move Termux home or the mount itself");
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to).catch(async (e: NodeJS.ErrnoException) => {
        if (e.code !== "EXDEV") throw e;
        // Home and shared storage are different filesystems: copy, then remove the original.
        await fs.cp(from, to, { recursive: true });
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
    async (a, c, resolve) => {
      if (!c.allowDelete) throw new Error("delete is off; the user can enable it with /dave:android delete on");
      const target = await resolve(a.path);
      if ((await roots(places, c)).includes(target)) throw new Error("refusing to delete Termux home or the mount itself");
      await fs.rm(target, { recursive: a.recursive === true });
      return `deleted ${target}`;
    },
  );

  tool(
    "search_files",
    "Search",
    "ripgrep: mode 'content' (regex) or 'name' (glob).",
    Type.Object({ path: text("folder"), pattern: text("regex or glob"), mode: Type.Optional(text("content | name")) }),
    async (a, _c, resolve) => {
      const dir = await resolve(a.path);
      const args = a.mode === "name" ? ["--files", "-g", a.pattern, dir] : ["-n", "--max-count", "5", "-e", a.pattern, dir];
      const { stdout } = await run("rg", args, { maxBuffer: 4 << 20 }).catch((e: { code?: number; stdout?: string }) => {
        // rg exits 1 for "no matches" and 2 when some files were unreadable but others matched.
        if (e.stdout || e.code === 1) return { stdout: e.stdout ?? "" };
        throw e;
      });
      const lines = stdout.split("\n").filter(Boolean);
      if (!lines.length) return "no matches";
      return lines.slice(0, 100).join("\n") + (lines.length > 100 ? `\n[${lines.length - 100} more]` : "");
    },
  );

  tool("file_info", "Info", "Size, times and MIME type.", Type.Object({ path: text("path") }), async (a, _c, resolve) => {
    const target = await resolve(a.path);
    const st = await fs.stat(target);
    const { stdout } = await run("file", ["-b", "--mime-type", target]).catch(() => ({ stdout: "unknown" }));
    return JSON.stringify({ path: target, dir: st.isDirectory(), size: st.size, modified: st.mtime, mime: stdout.trim() }, null, 2);
  });
}
