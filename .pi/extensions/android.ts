// DAVE on Android: native file tools, a local LFM2.5 model, and one rule for where files may be reached.
// Does nothing unless pi runs in Termux on Android, so this repo behaves the same on a desktop.
//
// In pi:  /dave:android                       status (the first time: the permissions list too)
//         /dave:android permissions           what Android, Termux and DAVE need, with live checks
//         /dave:android mount <folder>        opens one shared-storage folder (asks you first)
//         /dave:android unmount               closes it again
//         /dave:android delete on|off         lets delete_path run, or stops it
//         /dave:android model start|stop|status   the local model server
// Outside pi: scripts/dave-android.sh start|stop|status|logs. Details: docs/android.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  addReachNote,
  blockedShellRef,
  DEFAULT_CONFIG,
  defaultPlaces,
  guard,
  loadConfig,
  reachNote,
  saveConfig,
  validateMount,
  type Access,
  type Config,
} from "../lib/android-guard.ts";
import { permissionsReport } from "../lib/android-permissions.ts";
import { registerAndroidTools } from "../lib/android-tools.ts";

/** Pi's built-in tools that take a `path` (optional for ls, grep and find, which then use the working folder). */
const PATH_TOOLS: Record<string, Access> = { read: "read", ls: "read", grep: "read", find: "read", write: "write", edit: "write" };
const USAGE = "usage: /dave:android [status | permissions | mount <folder> | unmount | delete on|off | model start|stop|status]";
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "dave-android.sh");
const WIDGET = "dave-android-permissions";

const isAndroid = (): boolean => process.platform === "android" || (process.env.PREFIX ?? "").includes("com.termux");

const positive = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

/** The model server's address from hardware.json (`port`, default 8080). */
function modelUrl(file: string): string {
  try {
    const { port } = JSON.parse(readFileSync(file, "utf8")) as { port?: unknown };
    return `http://127.0.0.1:${positive(port) ? port : 8080}`;
  } catch {
    return "http://127.0.0.1:8080";
  }
}

/** DAVE's model as setup chose it: a provider (`dave-local`, or an endpoint saved in pi's models.json) and a model. */
type Choice = { provider: string; modelId: string; ctx: number; endpoint: string | null };

/** The model setup chose, or null when hardware.json is missing or malformed. */
function readChoice(file: string): Choice | null {
  try {
    const hw = JSON.parse(readFileSync(file, "utf8")) as { provider?: unknown; modelId?: unknown; ctx?: unknown; endpoint?: unknown };
    if (typeof hw.modelId !== "string" || !hw.modelId || !positive(hw.ctx)) return null;
    const provider = typeof hw.provider === "string" && hw.provider ? hw.provider : "dave-local";
    const endpoint = typeof hw.endpoint === "string" && hw.endpoint ? hw.endpoint : null;
    return { provider, modelId: hw.modelId, ctx: hw.ctx, endpoint };
  } catch {
    return null;
  }
}

export default function android(pi: ExtensionAPI): void {
  if (!isAndroid()) return;
  const places = defaultPlaces();
  let config: Config = { ...DEFAULT_CONFIG };
  registerAndroidTools(pi, places, () => config);

  const hardware = path.join(places.state, "hardware.json");
  const url = modelUrl(hardware);
  const choice = readChoice(hardware);
  // Only the phone's own model is registered here; an endpoint from setup is already in pi's models.json.
  const hw = choice?.provider === "dave-local" ? choice : null;
  if (hw) {
    pi.registerProvider("dave-local", {
      name: "DAVE local (llama.cpp)",
      baseUrl: `${url}/v1`,
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
  }

  pi.on("session_start", async (_event, ctx) => {
    const loaded = await loadConfig(places);
    config = loaded.config;
    ctx.ui.notify(config.mount ? `Android mount: ${config.mount}` : "Android files: Termux home only", "info");
    if (loaded.problem) ctx.ui.notify(loaded.problem, "warning");
  });

  // Tell the model, on every turn, exactly where its tools reach (the mount can change between turns).
  pi.on("before_agent_start", async (event) => addReachNote(event, reachNote(places, config)));

  // The same rule for pi's built-in tools. Relative paths resolve against pi's working folder, as pi does.
  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as { path?: unknown; command?: unknown };
    const access = PATH_TOOLS[event.toolName];
    if (access) {
      const target = typeof input.path === "string" ? input.path : ".";
      try {
        await guard(places, config, target, ctx.cwd, access);
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

  /** Shows the permissions list above the editor; any other /dave:android command closes it. */
  const showPermissions = async (ctx: ExtensionCommandContext) => {
    ctx.ui.setWidget(WIDGET, await permissionsReport(places, config, url, choice ? `${choice.provider}/${choice.modelId}` : null, choice?.endpoint ?? null));
    try {
      mkdirSync(places.state, { recursive: true });
      writeFileSync(path.join(places.state, "permissions-shown"), new Date().toISOString());
    } catch {
      // Can't remember it was shown; it will show again next time, which is harmless.
    }
  };

  /** Runs scripts/dave-android.sh and reports its last lines. */
  const model = async (sub: string, ctx: ExtensionCommandContext) => {
    const args = sub === "start" ? ["serve", "--no-wait"] : [sub];
    const result = await pi.exec("bash", [SCRIPT, ...args], { cwd: path.dirname(SCRIPT), timeout: 30_000 });
    const out = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-4).join("\n");
    ctx.ui.notify(out || `dave-android.sh ${args.join(" ")} exited ${result.code}`, result.code === 0 ? "info" : "error");
  };

  pi.registerCommand("dave:android", {
    description: "Android files: status | permissions | mount <folder> | unmount | delete on|off | model start|stop|status",
    handler: async (args, ctx) => {
      const line = String(args ?? "").trim();
      const sub = line.split(/\s+/)[0] || "status";
      const rest = line.slice(sub.length).trim(); // kept whole, so folder names with spaces survive
      ctx.ui.setWidget(WIDGET, undefined);
      if (sub === "permissions" || !existsSync(path.join(places.state, "permissions-shown"))) {
        await showPermissions(ctx);
        if (sub === "permissions") return;
      }
      if (sub === "model") {
        if (!["start", "stop", "status"].includes(rest)) return ctx.ui.notify("usage: /dave:android model start|stop|status", "error");
        return model(rest, ctx);
      }
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
