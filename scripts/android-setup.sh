#!/usr/bin/env bash
# Set up DAVE on an Android phone, inside Termux. Nothing here needs root.
#
#   bash scripts/android-setup.sh                    asks which model DAVE uses, then sets it up
#   bash scripts/android-setup.sh --provider local   llama.cpp on this phone (the default answer)
#   bash scripts/android-setup.sh --provider custom  any OpenAI-compatible endpoint: name, address, API key
#   bash scripts/android-setup.sh --update-pi        also update pi to its latest release
#
# pi comes from its own managed installer (https://pi.dev/install.sh), as in setup.sh, not npm:
# npm can hand out an older release. An npm-installed pi is replaced. PI_INSTALL_URL overrides the address.
#
# Only with --provider local:
#   --model REPO:Q   use this Hugging Face GGUF instead of the tier picked from your RAM
#   --ctx N          context size in tokens
#   --threads N      CPU threads for llama-server
#   --port N         local port for the model server (default 8080)
# With --provider custom, ENDPOINT_NAME, ENDPOINT_URL, ENDPOINT_API_KEY and ENDPOINT_MODEL in the
# environment answer its questions (see scripts/connect.mjs).
#
# Safe to run again, also to switch provider. Start and stop with scripts/dave-android.sh. The
# Android folder DAVE may reach is deliberately not set here: you set it inside pi with
# /dave:android mount <folder>.
set -euo pipefail

DAVE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.dave/android"
PI_INSTALL_URL="${PI_INSTALL_URL:-https://pi.dev/install.sh}"
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
# The managed pi's launcher lives here; first on PATH so this run (and the installer) use it.
export PATH="$PI_AGENT_DIR/bin:$PATH"
PROVIDER=""; MODEL_OVERRIDE=""; CTX_OVERRIDE=""; THREADS_OVERRIDE=""; PORT=8080; LOCAL_FLAGS=0; UPDATE_PI=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# value <flag> <value> [number]: the flag's value, refusing a missing one (or a non-number).
value() {
  [ -n "${2:-}" ] && [ "${2#--}" = "$2" ] || fail "$1 needs a value"
  [ -z "${3:-}" ] || [[ "$2" =~ ^[1-9][0-9]*$ ]] || fail "$1 needs a whole number, got: $2"
  printf '%s' "$2"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --provider) PROVIDER=$(value "$1" "${2:-}"); shift 2 ;;
    --model)    MODEL_OVERRIDE=$(value "$1" "${2:-}"); LOCAL_FLAGS=1; shift 2 ;;
    --ctx)      CTX_OVERRIDE=$(value "$1" "${2:-}" number); LOCAL_FLAGS=1; shift 2 ;;
    --threads)  THREADS_OVERRIDE=$(value "$1" "${2:-}" number); LOCAL_FLAGS=1; shift 2 ;;
    --port)     PORT=$(value "$1" "${2:-}" number); LOCAL_FLAGS=1; shift 2 ;;
    --update-pi) UPDATE_PI=1; shift ;;
    --no-model) fail "--no-model is now --provider custom" ;;
    *) fail "unknown flag: $1" ;;
  esac
done
case "$PROVIDER" in ""|local|custom) ;; *) fail "--provider must be local or custom, got: $PROVIDER" ;; esac

# ---------- 1. Termux ----------
[[ "${PREFIX:-}" == *com.termux* ]] || fail "run this inside Termux on Android"
ok "Termux on $(getprop ro.product.manufacturer), Android $(getprop ro.build.version.release)"

# ---------- 2. Which model DAVE uses (required; Enter means local) ----------
if [ -z "$PROVIDER" ]; then
  [ -t 0 ] || fail "no terminal to ask which model DAVE uses: add --provider local or --provider custom"
  printf '\nWhich model should DAVE use?\n'
  printf '  1) Local: llama.cpp on this phone (no network after the first download)  [default]\n'
  printf '  2) Another OpenAI-compatible endpoint (name, address, API key)\n'
  read -r -p "Pick [1]: " pick
  case "${pick:-1}" in
    1|local)  PROVIDER=local ;;
    2|custom) PROVIDER=custom ;;
    *) fail "pick 1 or 2, got: $pick" ;;
  esac
fi
[ "$PROVIDER" = local ] || [ "$LOCAL_FLAGS" -eq 0 ] || warn "--model, --ctx, --threads and --port only apply to --provider local; ignoring them"
ok "provider: $PROVIDER"

# ---------- 3. Packages ----------
[ "$PROVIDER" != local ] || [ "$(uname -m)" = aarch64 ] || warn "not arm64; expect slow inference"
NEED=()
PACKAGES=(nodejs:node ripgrep:rg file:file curl:curl)
[ "$PROVIDER" != local ] || PACKAGES+=(llama-cpp:llama-server)
for p in "${PACKAGES[@]}"; do
  command -v "${p#*:}" >/dev/null || NEED+=("${p%%:*}")
done
[ ${#NEED[@]} -eq 0 ] || { warn "installing ${NEED[*]}"; pkg update -y && pkg install -y "${NEED[@]}"; }
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' \
  || fail "Node $(node -v) is too old; run: pkg upgrade nodejs"
ok "packages, Node $(node -v)"

# pi: the managed install keeps its releases under $PI_AGENT_DIR; an npm-installed pi lives elsewhere.
pi_is_managed() {
  local found; found=$(command -v pi 2>/dev/null) || return 1
  case "$(readlink -f "$found")" in "$PI_AGENT_DIR"/*) return 0 ;; *) return 1 ;; esac
}
if [ "$UPDATE_PI" -eq 1 ] || ! pi_is_managed; then
  if command -v pi >/dev/null && ! pi_is_managed; then warn "replacing the npm-installed pi $(pi --version 2>/dev/null) with pi's managed install"; fi
  PI_INSTALLER="$(mktemp)"
  trap 'rm -f "$PI_INSTALLER"' EXIT
  curl -fsSL "$PI_INSTALL_URL" -o "$PI_INSTALLER" || fail "Couldn't download pi's installer from $PI_INSTALL_URL; check the network"
  # Run it with no terminal attached, so it takes its defaults (install, or replace an npm pi)
  # instead of waiting for a key, as setup.sh does.
  node -e '
    const { spawn } = require("child_process");
    const child = spawn("sh", [process.argv[1]], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code) => process.exit(code ?? 1));' "$PI_INSTALLER" || fail "pi's installer stopped with an error (shown above)"
  hash -r
  pi_is_managed || fail "pi installed, but $PI_AGENT_DIR/bin/pi isn't the pi this shell finds ($(command -v pi || echo none))"
fi
ok "pi $(pi --version 2>/dev/null | head -n 1) (managed, in $PI_AGENT_DIR)"

# New Termux sessions need to find the managed pi too.
profile="$HOME/.bashrc"
case "${SHELL:-}" in */zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;; esac
# shellcheck disable=SC2016 # written to the profile as is, expanded when a new shell starts
path_line='export PATH="$HOME/.pi/agent/bin:$PATH"'
if ! grep -Fqx "$path_line" "$profile" 2>/dev/null; then
  printf '\n# Added by agent-dave android-setup: the managed pi\n%s\n' "$path_line" >> "$profile"
  ok "added pi to your PATH in $profile (new sessions pick it up)"
fi

[ -d "$HOME/storage/shared" ] || { warn "accept the Android storage prompt"; termux-setup-storage; sleep 3; }
mkdir -p "$STATE"

# ---------- 4. The model ----------
# write_model <provider> <modelId> <hf model or ""> <ctx> <threads> <port> <endpoint url or "">: DAVE's
# model choice, as JSON. endpoint is a custom provider's base URL; empty means the local model.
write_model() {
  node -e 'const [provider, modelId, model, ctx, threads, port, endpoint] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ provider, modelId, model: model || null, ctx: Number(ctx), threads: Number(threads), port: Number(port), endpoint: endpoint || null }) + "\n");' \
    "$@" > "$STATE/hardware.json"
}

if [ "$PROVIDER" = local ]; then
  RAM_MB=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
  I8MM=$(grep -qw i8mm /proc/cpuinfo && echo 1 || echo 0)
  # Some phones hide cpufreq; fall back to every core.
  MAXF=$(cat /sys/devices/system/cpu/cpu*/cpufreq/cpuinfo_max_freq 2>/dev/null | sort -n | tail -1 || true)
  BIG=0
  for f in /sys/devices/system/cpu/cpu*/cpufreq/cpuinfo_max_freq; do
    [ -r "$f" ] && [ "$(cat "$f")" -ge $(( ${MAXF:-0} * 7 / 10 )) ] && BIG=$((BIG + 1))
  done
  [ "$BIG" -gt 0 ] || BIG=$(nproc)
  THREADS=${THREADS_OVERRIDE:-$BIG}
  FREE_GB=$(df -Pk "$HOME" | awk 'NR == 2 {print int($4 / 1048576)}')

  # MemTotal reads below the advertised RAM (an "8GB" phone shows about 7.4GB), so the cutoffs sit lower.
  if   [ "$RAM_MB" -ge 11000 ]; then MODEL="LiquidAI/LFM2.5-8B-A1B-GGUF:Q4_0";          CTX=32768
  elif [ "$RAM_MB" -ge 7000 ];  then MODEL="LiquidAI/LFM2.5-2.6B-GGUF:Q4_0";             CTX=16384
  elif [ "$RAM_MB" -ge 3500 ];  then MODEL="LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_0";    CTX=16384
  else                               MODEL="LiquidAI/LFM2.5-350M-GGUF:Q4_0";             CTX=8192
  fi
  MODEL=${MODEL_OVERRIDE:-$MODEL}
  CTX=${CTX_OVERRIDE:-$CTX}
  MODEL_ID=$(basename "${MODEL%%:*}" | sed 's/-GGUF$//')
  [ "$FREE_GB" -ge 8 ] || warn "under 8GB free; the model download may fail"
  write_model dave-local "$MODEL_ID" "$MODEL" "$CTX" "$THREADS" "$PORT" ""
  ok "RAM ${RAM_MB}MB, fast cores $BIG, i8mm=$I8MM -> $MODEL_ID, ctx $CTX, threads $THREADS, port $PORT"
else
  printf '\n'
  RESULT="$STATE/endpoint.json"
  node "$DAVE_DIR/scripts/connect.mjs" --custom --result "$RESULT"
  read_result() { node -e 'const r = require(process.argv[1]); const v = r[process.argv[2]]; process.stdout.write(v == null ? "" : String(v));' "$RESULT" "$1"; }
  ENDPOINT=$(read_result provider); MODEL_ID=$(read_result model); CTX=$(read_result contextWindow); BASE_URL=$(read_result baseUrl)
  CTX=${CTX:-32768}
  rm -f "$RESULT"
  write_model "$ENDPOINT" "$MODEL_ID" "" "$CTX" 0 "$PORT" "$BASE_URL"
fi

# read_file returns at most this many bytes: about a quarter of the model's context, at most 64KB.
READ_BYTES=$(( CTX < 65536 ? CTX : 65536 ))
# Re-runs update only the read limit to match the model; mount, delete and any other keys stay.
node -e 'const fs = require("fs"); const f = process.argv[1];
  let c;
  try { const p = JSON.parse(fs.readFileSync(f, "utf8")); if (p && typeof p === "object" && !Array.isArray(p)) c = p; } catch {}
  c = c || { mount: null, allowDelete: false };
  c.maxReadBytes = Number(process.argv[2]);
  fs.writeFileSync(f, JSON.stringify(c) + "\n");' "$STATE/config.json" "$READ_BYTES"
chmod 600 "$STATE/config.json"
ok "state in $STATE"

# ---------- Done ----------
warn "Settings > Apps > Termux > Battery: Unrestricted, or One UI may stop Termux in the background"
if [ "$PROVIDER" = local ]; then
  warn "Android 12+: turn off child process restrictions too (docs/android.md), or Android may kill the model server"
  printf '\nNext:\n'
  printf '  bash scripts/dave-android.sh start    starts the model (the first start downloads it), then pi\n'
  printf '  bash scripts/dave-android.sh stop     stops the model and releases the wake lock\n'
else
  # The same loopback rule the permissions report uses.
  if node --input-type=module -e 'const { isLoopback } = await import(process.argv[1]); process.exit(isLoopback(process.argv[2]) ? 0 : 1);' \
    "$DAVE_DIR/.pi/lib/android-permissions.ts" "$BASE_URL"; then
    ok "the model is served by an app on this phone at $BASE_URL; keep that app running"
  else
    warn "Every request now goes to $BASE_URL over the network"
  fi
  printf '\nNext:\n'
  printf '  bash scripts/dave-android.sh start    opens pi on %s/%s\n' "$ENDPOINT" "$MODEL_ID"
fi
printf '  In pi, trust the project when asked, then run /dave:android to see the permissions list.\n'
