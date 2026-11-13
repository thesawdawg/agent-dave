# DAVE on Android

DAVE runs fully on the phone in [Termux](https://termux.dev/): pi, a local LFM2.5 model served by
llama.cpp on `127.0.0.1:8080`, and native file tools that reach only Termux home plus one
shared-storage folder you choose. The extension is [`.pi/extensions/android.ts`](../.pi/extensions/android.ts);
on a desktop it does nothing.

## Set up (once)

Install Termux from [F-Droid or GitHub](https://github.com/termux/termux-app#installation) (not Google Play), clone this repo inside Termux, then:

```bash
bash scripts/android-setup.sh
```

It installs `nodejs`, `ripgrep`, `llama-cpp` and `file` if missing, checks Node 22.19+, installs pi,
asks for files access, picks a model size from your RAM, and writes `~/.dave/android/hardware.json`
and `config.json`. Options: `--model <hf-repo:quant>`, `--ctx <tokens>`, `--threads <n>`,
`--port <n>` (model server port, default 8080), `--no-model`.
Safe to run again.

## Start and stop

| What | Command | What happens |
|---|---|---|
| Start everything | `bash scripts/dave-android.sh start` | Holds a wake lock, starts llama-server in the background, waits until the model is ready (the first start downloads it), then opens pi on the local model. Extra arguments go to pi. |
| Start the model only | `bash scripts/dave-android.sh serve` (`--no-wait` to return at once) | The model server without pi. |
| Stop pi | `/quit` in pi, or Ctrl+C twice | pi exits. The model server keeps running for the next start. |
| Stop the model | `bash scripts/dave-android.sh stop` | Stops llama-server (SIGTERM, then SIGKILL after 10s) and releases the wake lock. |
| Check | `bash scripts/dave-android.sh status` | Model server pid and health, wake lock, files access, mount and delete settings. |
| Model log | `bash scripts/dave-android.sh logs` (`-f` to follow) | The last 50 lines of `~/.dave/android/llm.log`. |

Inside pi: `/dave:android model start|stop|status` does the same for the model server.
The first time you open pi, trust the project when asked; DAVE's extensions load only in a trusted project.

What runs, and where it is recorded:

| Process | Started by | Recorded in | Stopped by |
|---|---|---|---|
| `llama-server` | `start` / `serve` | `~/.dave/android/llm.pid`, log `llm.log` | `stop` |
| Termux wake lock | `start` / `serve` | `~/.dave/android/wakelock` | `stop`, or if the server dies while loading |
| `pi` | `start`, or `pi` in this folder | (foreground) | `/quit` |

`stop` releases Termux's wake lock even if something else took it.

## Permissions and settings

pi shows this list the first time you run `/dave:android`, and any time with `/dave:android permissions`,
with live checks for files access, the model server and the wake lock.

### Android settings for Termux

| Setting | Why | How |
|---|---|---|
| Files access | Only needed to mount a shared-storage folder. Termux home needs nothing. | `termux-setup-storage`, then allow. |
| Battery: Unrestricted | One UI otherwise stops Termux and the model server in the background. | Settings > Apps > Termux > Battery > Unrestricted. On Samsung, also keep Termux out of Settings > Battery > Background usage limits > Sleeping apps. |
| Child process restrictions (Android 12+) | Android's phantom-process limits can kill llama-server with signal 9 even with battery Unrestricted. | Android 14+: Developer options > Disable child process restrictions. Android 12L/13: `adb shell settings put global settings_enable_monitor_phantom_procs false`. Android 12: `adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent; /system/bin/device_config put activity_manager max_phantom_processes 2147483647"`. Commands as given in Termux's documentation; check yours against your Android version. |
| Notifications (Android 13+, optional) | Shows Termux's notification with the wake lock and an Exit button. | Allow notifications for Termux. |

No root, no Termux:API app, and no other Android permission is needed.

### The Termux user

- Reads and writes its own home (`/data/data/com.termux/files/home`), as every Termux user does.
- Runs `node`, `pi`, `llama-server`, `rg` and `file`; setup installs them.
- Listens only on `127.0.0.1:8080` (the model). The first model start downloads the model from Hugging Face; after that DAVE makes no network calls of its own.
- Holds a wake lock while the model serves.

### DAVE's tools

| Tool | Needs |
|---|---|
| `list_dir`, `read_file`, `search_files`, `file_info` | Read access in Termux home or the mounted folder. |
| `write_file`, `edit_file`, `move_path` | Write access there. `move_path` never overwrites. |
| `delete_path` | Write access, plus `/dave:android delete on`. The guard also asks each time. |
| pi's `read`, `write`, `edit`, `ls`, `grep`, `find` | The same rule, checked before each call. |
| pi's `bash` | Best effort: a command naming shared storage outside the mount, or `~/.dave/android`, is blocked. A shell can still get around a text check. |

| You run | Effect |
|---|---|
| `/dave:android mount <folder>` | Opens one folder inside shared storage (asks you to confirm). Not all of shared storage. |
| `/dave:android unmount` | Closes it. |
| `/dave:android delete on` / `off` | Allows or stops `delete_path`. |

No tool may change DAVE's permissions or Pi's settings: `~/.dave/android`, `~/.pi/agent`, this repo's
`.pi/extensions`, `.pi/lib`, `.pi/guard.jsonc` and `.pi/mcp.json`, or anything under `.git` or `.ssh`.
No tool may read `.env` files or Pi's key files (`auth.json`, `models.json`, `guard-judge.json`).

## Troubleshooting

| You see | Do |
|---|---|
| `model server stopped while loading`, or signal 9 in the log | Android killed it: check battery Unrestricted and child process restrictions above. Also check free memory; try `--ctx 8192` or a smaller `--model`. |
| `something else already answers on http://127.0.0.1:8080` | Another server holds the port. Stop it, or rerun setup with `--port <n>` and restart pi. |
| `Termux can't open shared storage` | Run `termux-setup-storage` and allow access. |
| `outside Termux home ...` | Expected: mount the folder with `/dave:android mount <folder>`. |
| `protected DAVE/Pi path` | Expected: the model tried to change its own settings. |
| `saved mount ... is closed for now` | The mounted folder is gone or files access was revoked. Fix that and restart pi, or mount again. |
| pi starts on another model | Start with `dave-android.sh start`, or `/model` and pick `dave-local`. |
| `fetch` MCP server failed at startup | Expected on the phone: it needs `uvx`, which setup doesn't install. |

## Not yet verified on a device

- The LFM2.5 Hugging Face repo names in the setup script's tiers.
- That Termux's `llama-cpp` package can download with `-hf`.
- Whether the largest tier fits in free memory on a 12GB phone.
