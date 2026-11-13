#!/usr/bin/env bash
# Start and stop DAVE on an Android phone (Termux). Run scripts/android-setup.sh once first.
#
#   bash scripts/dave-android.sh start [pi args]   start the model server, wait until it's ready, open pi on it
#   bash scripts/dave-android.sh serve [--no-wait] start only the model server (in the background)
#   bash scripts/dave-android.sh stop              stop the model server and release the wake lock
#   bash scripts/dave-android.sh status            model server, wake lock, storage access, mount
#   bash scripts/dave-android.sh logs [-f]         the model server's log (-f keeps following it)
#
# pi itself stops with /quit (or Ctrl+C twice); the model server keeps running until "stop".
# Inside pi the same server controls are /dave:android model start|stop|status.
set -euo pipefail

DAVE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.dave/android"
HARDWARE="$STATE/hardware.json"
PIDFILE="$STATE/llm.pid"
LOG="$STATE/llm.log"
WAKE="$STATE/wakelock"

if [ -t 1 ]; then
  ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
  warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
  fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
else
  ok()   { printf '  ok: %s\n' "$1"; }
  warn() { printf '  warning: %s\n' "$1"; }
  fail() { printf '  error: %s\n' "$1"; exit 1; }
fi

# One field from hardware.json, or empty.
hw() { node -e 'try { const v = require(process.argv[1])[process.argv[2]]; process.stdout.write(v == null ? "" : String(v)); } catch {}' "$HARDWARE" "$1"; }

PORT=$(hw port); PORT=${PORT:-8080}
URL="http://127.0.0.1:$PORT"

# The server's pid if our llama-server is running, else nothing (a stale pidfile is removed).
server_pid() {
  [ -f "$PIDFILE" ] || return 0
  local pid; pid=$(cat "$PIDFILE")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q llama-server; then
    echo "$pid"
  else
    rm -f "$PIDFILE"
  fi
}

# ready, loading or down, from llama-server's /health endpoint.
health() {
  node -e 'fetch(process.argv[1] + "/health", { signal: AbortSignal.timeout(1500) })
    .then((r) => process.stdout.write(r.ok ? "ready" : "loading"), () => process.stdout.write("down"))' "$URL"
}

wake_lock()   { command -v termux-wake-lock >/dev/null && termux-wake-lock && touch "$WAKE" || true; }
wake_unlock() { command -v termux-wake-unlock >/dev/null && termux-wake-unlock || true; rm -f "$WAKE"; }

serve() {
  local wait=1; [ "${1:-}" = "--no-wait" ] && wait=0
  [ -f "$HARDWARE" ] || fail "not set up yet: run bash scripts/android-setup.sh"
  local model ctx threads; model=$(hw model); ctx=$(hw ctx); threads=$(hw threads)
  [ -n "$model" ] || fail "no local model configured (setup ran with --no-model)"
  command -v llama-server >/dev/null || fail "llama-server not found: run bash scripts/android-setup.sh"

  local pid; pid=$(server_pid)
  if [ -z "$pid" ]; then
    [ "$(health)" = down ] || fail "something else already answers on $URL; stop it first"
    # Keep the log from growing without limit across restarts.
    [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5242880 ] && mv "$LOG" "$LOG.1"
    wake_lock
    printf '\n--- %s starting %s\n' "$(date)" "$model" >> "$LOG"
    nohup llama-server -hf "$model" --jinja --host 127.0.0.1 --port "$PORT" -c "$ctx" -t "$threads" \
      --temp 0.1 --top-k 50 --repeat-penalty 1.05 >> "$LOG" 2>&1 &
    pid=$!
    echo "$pid" > "$PIDFILE"
    ok "model server starting (pid $pid, log $LOG)"
  else
    ok "model server already running (pid $pid)"
  fi
  [ "$wait" -eq 1 ] || return 0

  local waited=0
  until [ "$(health)" = ready ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PIDFILE"; wake_unlock
      tail -n 15 "$LOG" >&2
      fail "model server stopped while loading (log above; signal 9 usually means Android killed it, see docs/android.md)"
    fi
    if [ $((waited % 15)) -eq 0 ]; then
      warn "loading... ${waited}s (the first start downloads the model; Ctrl+C stops waiting, the server keeps going)"
    fi
    sleep 3; waited=$((waited + 3))
  done
  ok "model server ready on $URL"
}

stop() {
  local pid; pid=$(server_pid)
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
    ok "model server stopped"
  else
    ok "model server was not running"
  fi
  wake_unlock
  ok "wake lock released"
}

status() {
  local pid; pid=$(server_pid)
  if [ -n "$pid" ]; then ok "model server: pid $pid, $(health) ($(hw modelId))"; else warn "model server: stopped"; fi
  if [ -f "$WAKE" ]; then ok "wake lock: held"; else ok "wake lock: not held"; fi
  if ls /storage/emulated/0 >/dev/null 2>&1; then ok "files access: granted"; else warn "files access: not granted (termux-setup-storage)"; fi
  # shellcheck disable=SC2016 # ${...} below is JavaScript, not shell
  node -e 'try { const c = require(process.argv[1]); console.log(`  mount: ${c.mount ?? "none"} · delete: ${c.allowDelete ? "on" : "off"}`); } catch { console.log("  mount: none · delete: off"); }' "$STATE/config.json"
}

logs() {
  [ -f "$LOG" ] || fail "no log yet: the model server hasn't started"
  if [ "${1:-}" = "-f" ]; then tail -n 50 -f "$LOG"; else tail -n 50 "$LOG"; fi
}

start() {
  serve
  local id; id=$(hw modelId)
  cd "$DAVE_DIR"
  exec pi --model "dave-local/$id" "$@"
}

cmd="${1:-help}"; [ $# -gt 0 ] && shift
case "$cmd" in
  start)  start "$@" ;;
  serve)  serve "$@" ;;
  stop)   stop ;;
  status) status ;;
  logs)   logs "$@" ;;
  *)      sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
