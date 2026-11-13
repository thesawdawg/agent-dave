/**
 * What DAVE needs from Android, from the Termux user and from you, with live checks where
 * they can be made. Shown the first time /dave:android runs on a phone and with
 * /dave:android permissions. docs/android.md has the same list with more detail.
 */
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { Config, Places } from "./android-guard.ts";

/** "ready", "loading" (model still loading or downloading) or "not running", for the server at `url`. */
export async function serverState(url: string): Promise<"ready" | "loading" | "not running"> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? "ready" : "loading";
  } catch {
    return "not running";
  }
}

/** True when Termux may read shared storage, i.e. termux-setup-storage was allowed. */
export async function storageGranted(places: Places): Promise<boolean> {
  try {
    await fs.access(places.shared, constants.R_OK);
    await fs.readdir(places.shared);
    return true;
  } catch {
    return false;
  }
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);
const mark = (ok: boolean) => (ok ? "✓" : "✗");

/**
 * The permissions report as lines, with live status marks. `model` is DAVE's model as
 * `provider/id` from setup (`dave-local/...` for the phone's own), or null before setup.
 */
export async function permissionsReport(places: Places, config: Config, url: string, model: string | null): Promise<string[]> {
  const local = !model || model.startsWith("dave-local/");
  const [storage, server, wake] = await Promise.all([
    storageGranted(places),
    local ? serverState(url) : Promise.resolve("not used"),
    exists(path.join(places.state, "wakelock")),
  ]);
  const modelLines = local
    ? [
        `  ${mark(!!model)} Model: ${model ?? "not set up (bash scripts/android-setup.sh)"} · server on ${url.replace("http://", "")}: ${server}`,
        `  ${wake ? "•" : "○"} Wake lock: ${wake ? "held while the model serves" : "not held"} (released by dave-android.sh stop).`,
        "  • Network: the first model start downloads the model; after that, only 127.0.0.1.",
      ]
    : [
        `  ✓ Model: ${model} (an endpoint from setup, saved in ~/.pi/agent/models.json)`,
        "  • Network: every request to the model goes to that endpoint over the internet or your network.",
      ];
  return [
    "DAVE on Android: permissions and settings  (full list: docs/android.md)",
    "",
    "Android settings for Termux",
    `  ${mark(storage)} Files access: run termux-setup-storage and allow it. Needed only to mount a shared folder.`,
    "  • Battery: Settings > Apps > Termux > Battery > Unrestricted, or One UI stops Termux in the background.",
    ...(local
      ? [
          "  • Android 12+: turn off child process restrictions (Developer options on 14+, adb on 12-13),",
          "    or Android may kill llama-server with signal 9. See docs/android.md.",
        ]
      : []),
    "  • Notifications for Termux (Android 13+, optional): shows Termux's notification and an Exit button.",
    "",
    "Termux user",
    `  • Reads and writes Termux home; runs node, pi, rg and file${local ? ", llama-server" : ""} (setup installs them).`,
    ...modelLines,
    "",
    "DAVE's tools",
    "  • list_dir, read_file, search_files, file_info: read Termux home and the mounted folder.",
    "  • write_file, edit_file, move_path: write there too. No tool may change DAVE's permissions,",
    "    guard rules or Pi's settings.",
    `  • Mount: ${config.mount ?? "none"} — /dave:android mount <folder> (asks you first) · unmount`,
    `  • delete_path: ${config.allowDelete ? "on" : "off"} — /dave:android delete on|off`,
    "",
    "Start, stop, status: scripts/dave-android.sh start|stop|status|logs · in pi: /dave:android model start|stop|status",
  ];
}
