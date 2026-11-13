// DAVE on Android: native file tools, a local LFM2.5 model, and one rule for where files may be reached.
// Does nothing unless pi runs in Termux on Android, so this repo behaves the same on a desktop.
//
// In pi:  /dave:android                  shows the mount and whether delete is on
//         /dave:android mount <folder>   opens one shared-storage folder (asks you first)
//         /dave:android unmount          closes it again
//         /dave:android delete on|off    lets delete_path run, or stops it
// Set up the phone with scripts/android-setup.sh. Rules and checks live in .pi/lib/android-guard.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { blockedShellRef, DEFAULT_CONFIG, defaultPlaces, guard, loadConfig, saveConfig, validateMount, type Config } from "../lib/android-guard.ts";
import { registerAndroidTools } from "../lib/android-tools.ts";

/** Pi's built-in tools that take a `path` (optional for ls, grep and find, which then use the working folder). */
const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);
const USAGE = "usage: /dave:android [status | mount <folder> | unmount | delete on|off]";

/** What setup detected about the phone; written by scripts/android-setup.sh. */
type Hardware = { modelId: string; ctx: number };

const isAndroid = (): boolean => process.platform === "android" || (process.env.PREFIX ?? "").includes("com.termux");

export default function android(pi: ExtensionAPI): void {
  if (!isAndroid()) return;
  const places = defaultPlaces();
  let config: Config = { ...DEFAULT_CONFIG };
  registerAndroidTools(pi, places, () => config);

  // The local model, at the tier the setup script picked. No hardware.json yet: run the setup script.
  try {
    const hw = JSON.parse(readFileSync(path.join(places.state, "hardware.json"), "utf8")) as Hardware;
    pi.registerProvider("dave-local", {
      name: "DAVE local (llama.cpp)",
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "local",
      api: "openai-completions",
      models: [
        {
          type: "chat",
          id: hw.modelId,
          name: hw.modelId,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: hw.ctx,
          maxTokens: 4096,
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        },
      ],
    });
  } catch {
    // Not set up yet; the file tools still work with any model.
  }

  pi.on("session_start", async (_event, ctx) => {
    config = await loadConfig(places);
    ctx.ui.notify(config.mount ? `Android mount: ${config.mount}` : "Android files: Termux home only", "info");
  });

  // The same rule for pi's built-in tools. Relative paths resolve against pi's working folder, as pi does.
  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as { path?: unknown; command?: unknown };
    if (PATH_TOOLS.has(event.toolName)) {
      const target = typeof input.path === "string" ? input.path : ".";
      try {
        await guard(places, config, target, ctx.cwd);
      } catch (e) {
        return { block: true, reason: (e as Error).message };
      }
    }
    if (event.toolName === "bash" && typeof input.command === "string") {
      const ref = await blockedShellRef(places, config, input.command);
      if (ref) return { block: true, reason: `bash touches ${ref}, outside what DAVE may reach on Android` };
    }
    return undefined;
  });

  pi.registerCommand("dave:android", {
    description: "Android files: status | mount <folder> | unmount | delete on|off",
    handler: async (args, ctx) => {
      const line = String(args ?? "").trim();
      const sub = line.split(/\s+/)[0] || "status";
      const rest = line.slice(sub.length).trim(); // kept whole, so folder names with spaces survive
      if (sub === "mount") {
        if (!ctx.hasUI) return ctx.ui.notify("mount needs you at the screen to confirm", "error");
        const real = await validateMount(places, rest).catch((e: Error) => {
          ctx.ui.notify(e.message, "error");
          return null;
        });
        if (!real) return;
        const ok = await ctx.ui.confirm("Mount Android folder", `DAVE will be able to read and write ${real}. Replace any previous mount?`);
        if (!ok) return;
        config.mount = real;
      } else if (sub === "unmount") {
        config.mount = null;
      } else if (sub === "delete" && (rest === "on" || rest === "off")) {
        config.allowDelete = rest === "on";
      } else if (sub !== "status") {
        return ctx.ui.notify(USAGE, "error");
      }
      if (sub !== "status") await saveConfig(places, config);
      ctx.ui.notify(`mount: ${config.mount ?? "none"} · delete: ${config.allowDelete ? "on" : "off"}`, "info");
    },
  });
}
