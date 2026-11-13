#!/usr/bin/env bash
# Set up DAVE on an Android phone, inside Termux. Nothing here needs root.
#
#   bash scripts/android-setup.sh                    asks which model DAVE uses, then sets it up
#   bash scripts/android-setup.sh --provider local   llama.cpp on this phone (the default answer)
#   bash scripts/android-setup.sh --provider custom  any OpenAI-compatible endpoint: name, address, API key
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
PROVIDER=""; MODEL_OVERRIDE=""; CTX_OVERRIDE=""; THREADS_OVERRIDE=""; PORT=8080; LOCAL_FLAGS=0

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
PACKAGES=(nodejs:node ripgrep:rg file:file)
[ "$PROVIDER" != local ] || PACKAGES+=(llama-cpp:llama-server)
for p in "${PACKAGES[@]}"; do
  command -v "${p#*:}" >/dev/null || NEED+=("${p%%:*}")
done
[ ${#NEED[@]} -eq 0 ] || { warn "installing ${NEED[*]}"; pkg update -y && pkg install -y "${NEED[@]}"; }
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' \
  || fail "Node $(node -v) is too old; run: pkg upgrade nodejs"
command -v pi >/dev/null || { warn "installing pi"; npm install -g --ignore-scripts @earendil-works/pi-coding-agent; }
ok "packages, Node $(node -v), pi $(pi --version 2>/dev/null || echo present)"

[ -d "$HOME/storage/shared" ] || { warn "accept the Android storage prompt"; termux-setup-storage; sleep 3; }
mkdir -p "$STATE"

# ---------- 4. The model ----------
# write_model <provider> <modelId> <hf model or ""> <ctx> <threads> <port>: DAVE's model choice, as JSON.
write_model() {
  node -e 'const [provider, modelId, model, ctx, threads, port] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ provider, modelId, model: model || null, ctx: Number(ctx), threads: Number(threads), port: Number(port) }) + "\n");' \
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
  if   [ "$RAM_MB" -ge 11000 ]; then MODEL="LiquidAI/LFM2.5-8B-A1B-GGUF:Q4_K_M";       CTX=32768
  elif [ "$RAM_MB" -ge 7000 ];  then MODEL="LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M";          CTX=16384
  elif [ "$RAM_MB" -ge 3500 ];  then MODEL="LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M"; CTX=16384
  else                               MODEL="LiquidAI/LFM2.5-350M-GGUF:Q4_0";             CTX=8192
  fi
  MODEL=${MODEL_OVERRIDE:-$MODEL}
  CTX=${CTX_OVERRIDE:-$CTX}
  MODEL_ID=$(basename "${MODEL%%:*}" | sed 's/-GGUF$//')
  [ "$FREE_GB" -ge 8 ] || warn "under 8GB free; the model download may fail"
  write_model dave-local "$MODEL_ID" "$MODEL" "$CTX" "$THREADS" "$PORT"
  ok "RAM ${RAM_MB}MB, fast cores $BIG, i8mm=$I8MM -> $MODEL_ID, ctx $CTX, threads $THREADS, port $PORT"
else
  printf '\n'
  RESULT="$STATE/endpoint.json"
  node "$DAVE_DIR/scripts/connect.mjs" --custom --result "$RESULT"
  read_result() { node -e 'const r = require(process.argv[1]); const v = r[process.argv[2]]; process.stdout.write(v == null ? "" : String(v));' "$RESULT" "$1"; }
  ENDPOINT=$(read_result provider); MODEL_ID=$(read_result model); CTX=$(read_result contextWindow)
  CTX=${CTX:-32768}
  rm -f "$RESULT"
  write_model "$ENDPOINT" "$MODEL_ID" "" "$CTX" 0 "$PORT"
fi

# read_file returns at most this many bytes: about a quarter of the model's context, at most 64KB.
READ_BYTES=$(( CTX < 65536 ? CTX : 65536 ))
[ -f "$STATE/config.json" ] || printf '{"mount":null,"allowDelete":false,"maxReadBytes":%s}\n' "$READ_BYTES" > "$STATE/config.json"
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
  warn "Every request now goes to $ENDPOINT over the network"
  printf '\nNext:\n'
  printf '  bash scripts/dave-android.sh start    opens pi on %s/%s\n' "$ENDPOINT" "$MODEL_ID"
fi
printf '  In pi, trust the project when asked, then run /dave:android to see the permissions list.\n'
