#!/usr/bin/env bash
# Set up DAVE on an Android phone, inside Termux. Nothing here needs root.
#
#   bash scripts/android-setup.sh                  check packages, pick a local model, write the launcher
#   bash scripts/android-setup.sh --model REPO:Q   use this Hugging Face GGUF instead of the detected tier
#   bash scripts/android-setup.sh --ctx N          context size in tokens
#   bash scripts/android-setup.sh --threads N      CPU threads for llama-server
#   bash scripts/android-setup.sh --no-model       skip the model launcher (use another provider)
#
# Safe to run again. The Android folder DAVE may reach is deliberately not set here:
# you set it inside pi with /dave:android mount <folder>.
set -euo pipefail

DAVE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.dave/android"
MODEL_OVERRIDE=""; CTX_OVERRIDE=""; THREADS_OVERRIDE=""; SKIP_MODEL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --model)    MODEL_OVERRIDE="$2"; shift 2 ;;
    --ctx)      CTX_OVERRIDE="$2"; shift 2 ;;
    --threads)  THREADS_OVERRIDE="$2"; shift 2 ;;
    --no-model) SKIP_MODEL=1; shift ;;
    *) fail "unknown flag: $1" ;;
  esac
done

# ---------- 1. Termux and packages ----------
[[ "${PREFIX:-}" == *com.termux* ]] || fail "run this inside Termux on Android"
ok "Termux on $(getprop ro.product.manufacturer), Android $(getprop ro.build.version.release)"
[ "$(uname -m)" = aarch64 ] || warn "not arm64; expect slow inference"

NEED=()
for p in nodejs:node ripgrep:rg llama-cpp:llama-server file:file; do
  command -v "${p#*:}" >/dev/null || NEED+=("${p%%:*}")
done
[ ${#NEED[@]} -eq 0 ] || { warn "installing ${NEED[*]}"; pkg update -y && pkg install -y "${NEED[@]}"; }
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' \
  || fail "Node $(node -v) is too old; run: pkg upgrade nodejs"
command -v pi >/dev/null || { warn "installing pi"; npm install -g --ignore-scripts @earendil-works/pi-coding-agent; }
ok "packages, Node $(node -v), pi $(pi --version 2>/dev/null || echo present)"

[ -d "$HOME/storage/shared" ] || { warn "accept the Android storage prompt"; termux-setup-storage; sleep 3; }

# ---------- 2. Hardware and model tier ----------
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
ok "RAM ${RAM_MB}MB, fast cores $BIG, i8mm=$I8MM -> $MODEL_ID, ctx $CTX, threads $THREADS"

# ---------- 3. DAVE's Android state ----------
mkdir -p "$STATE"
printf '{"modelId":"%s","model":"%s","ctx":%s,"threads":%s,"ramMb":%s,"i8mm":%s}\n' \
  "$MODEL_ID" "$MODEL" "$CTX" "$THREADS" "$RAM_MB" "$I8MM" > "$STATE/hardware.json"
[ -f "$STATE/config.json" ] || printf '{"mount":null,"allowDelete":false,"maxReadBytes":262144}\n' > "$STATE/config.json"
chmod 600 "$STATE/config.json"
ok "state in $STATE"

# ---------- 4. Model launcher ----------
if [ "$SKIP_MODEL" -eq 0 ]; then
  cat > "$STATE/start-llm.sh" <<EOF
#!/usr/bin/env bash
# Starts the local model for DAVE on 127.0.0.1:8080. Written by scripts/android-setup.sh.
termux-wake-lock 2>/dev/null || true
exec llama-server -hf "$MODEL" --jinja --host 127.0.0.1 --port 8080 -c $CTX -t $THREADS --temp 0.1 --top-k 50 --repeat-penalty 1.05
EOF
  chmod +x "$STATE/start-llm.sh"
  ok "launcher: $STATE/start-llm.sh (the first run downloads the model)"
fi

warn "Settings > Apps > Termux > Battery: Unrestricted, or One UI will stop llama-server"
echo
echo "Next:"
echo "  1. $STATE/start-llm.sh   (in its own Termux session)"
echo "  2. cd $DAVE_DIR && pi    (trust the project when asked, so DAVE's extensions load)"
echo "  3. /model dave-local, then /dave:android mount <folder> if DAVE needs one"
