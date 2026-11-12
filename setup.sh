#!/usr/bin/env bash
# Set up DAVE on Linux or macOS. Nothing here needs sudo.
#
#   ./setup.sh               install pi, Node.js and uv, connect to the studio, then open VS Code
#   ./setup.sh --forget-key  remove the saved studio key (run it on shared machines afterward)
#   ./setup.sh --integrations  configure GitHub, Redmine and worker limits
#   ./setup.sh --judge       connect the guard's judge, a separate decision model (advanced)
#   ./setup.sh --forget-judge  remove the judge connection
#
# Safe to run again: anything already installed is kept.
# On Windows, use setup.ps1 instead.
set -euo pipefail
cd "$(dirname "$0")"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Where the installers come from. Override only to use a local mirror.
PI_INSTALL_URL="${PI_INSTALL_URL:-https://pi.dev/install.sh}"
UV_INSTALL_URL="${UV_INSTALL_URL:-https://astral.sh/uv/install.sh}"
VSCODE_MAC_URL="${VSCODE_MAC_URL:-https://update.code.visualstudio.com/latest/darwin-universal/stable}"

# Everything goes in your home folder, where pi's own installer puts it.
NODE_BIN="${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin"
PI_BIN="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin"
UV_BIN="$HOME/.local/bin"
export PATH="$PI_BIN:$NODE_BIN:$UV_BIN:$PATH"

node_ok() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null
}

if [ "${1:-}" = "--forget-key" ]; then
  node_ok || fail "Node.js isn't installed, so there's no saved key to remove."
  exec node scripts/connect.mjs --forget-key
fi
if [ "${1:-}" = "--hub" ]; then
  node_ok || fail "Run ./setup.sh first; Hub setup needs Node.js."
  exec node scripts/setup-hub.mjs
fi
if [ "${1:-}" = "--integrations" ]; then
  node_ok || fail "Run ./setup.sh first; integration setup needs Node.js."
  exec node scripts/configure-dave.mjs
fi
case "${1:-}" in --judge|--forget-judge)
  node_ok || fail "Run ./setup.sh first; the judge setup needs its Node.js."
  exec node scripts/connect.mjs "$1"
esac

printf '\033[1mSetting up DAVE\033[0m\n'

# ---------- 1. What setup can't install without sudo ----------
step "1. Checking this machine"
missing=""
for tool in curl tar; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
[ "$(uname -s)" = Linux ] && ! command -v xz >/dev/null 2>&1 && missing="$missing xz"
if [ -n "$missing" ]; then
  fail "This machine is missing:$missing. They need an administrator to install (Ubuntu: sudo apt install$missing). On a studio machine, ask for help; otherwise pair up for now."
fi
ok "curl and tar are here"
command -v git >/dev/null 2>&1 && ok "git is here" || warn "git isn't installed. You can still use this copy of the repo."

# pi's installer is the source of truth for where pi and its Node.js live.
PI_INSTALLER="$(mktemp "${TMPDIR:-/tmp}/pi-install.XXXXXX")"
trap 'rm -f "$PI_INSTALLER" "$PI_INSTALLER.lib"' EXIT
get_pi_installer() {
  [ -s "$PI_INSTALLER" ] && return 0
  curl -fsSL "$PI_INSTALL_URL" -o "$PI_INSTALLER" || fail "Couldn't download pi's installer from pi.dev. Check the network, or use the offline bundle."
}

# ---------- 2. Node.js (pi's own standalone copy, no sudo) ----------
step "2. Node.js"
if node_ok; then
  ok "Node.js $(node --version)"
else
  get_pi_installer
  # Reuse the installer's own verified Node.js download, without running the rest of it.
  [ "$(tail -n 1 "$PI_INSTALLER")" = 'pi_installer_main "$@"' ] || fail "pi's installer has changed shape; install pi by hand from https://pi.dev, then run ./setup.sh again."
  sed '$d' "$PI_INSTALLER" > "$PI_INSTALLER.lib"
  sh -c 'set -eu; . "$1"; install_node_standalone' sh "$PI_INSTALLER.lib" || fail "Couldn't install Node.js."
  hash -r
  node_ok || fail "Node.js installed, but it doesn't run. Ask for help."
  ok "Node.js $(node --version), in $(dirname "$NODE_BIN")"
fi

# ---------- 3. pi ----------
step "3. pi"
if command -v pi >/dev/null 2>&1 && pi --version >/dev/null 2>&1; then
  ok "pi $(pi --version 2>/dev/null | head -n 1) is already installed"
else
  get_pi_installer
  # Run the installer with no terminal attached, so it takes its defaults:
  # install pi, and don't stop to ask whether to start it.
  node -e '
    const { spawn } = require("child_process");
    const child = spawn("sh", [process.argv[1]], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code) => process.exit(code ?? 1));' "$PI_INSTALLER" || fail "pi's installer stopped with an error (shown above)."
  hash -r
  command -v pi >/dev/null 2>&1 || fail "pi installed, but it can't be found in $PI_BIN."
  ok "pi $(pi --version 2>/dev/null | head -n 1)"
fi

# New terminals need to find pi and uv too.
profile="$HOME/.bashrc"
case "${SHELL:-}" in */zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;; esac
path_line='export PATH="$HOME/.pi/agent/bin:$HOME/.local/bin:$PATH"'
if ! grep -Fqx "$path_line" "$profile" 2>/dev/null; then
  printf '\n# Added by agent-dave setup: pi and uv\n%s\n' "$path_line" >> "$profile"
  ok "Added pi and uv to your PATH in $profile"
fi

# ---------- 4. uv (runs the fetch server) ----------
step "4. uv"
if [ -x "$UV_BIN/uvx" ]; then
  ok "uv $("$UV_BIN/uv" --version 2>/dev/null | cut -d' ' -f2) is already installed"
else
  curl -LsSf "$UV_INSTALL_URL" | env UV_INSTALL_DIR="$UV_BIN" UV_NO_MODIFY_PATH=1 sh -s -- --quiet || fail "Couldn't install uv."
  hash -r
  [ -x "$UV_BIN/uvx" ] || fail "uv installed, but uvx isn't in $UV_BIN. Ask for help."
  ok "uv $("$UV_BIN/uv" --version 2>/dev/null | cut -d' ' -f2), in $UV_BIN"
fi
# pi starts the fetch server by running uvx, so put uvx right next to pi:
# wherever your terminal finds pi, pi finds uvx too.
pi_dir="$(dirname "$(command -v pi)")"
if [ "$pi_dir" != "$UV_BIN" ]; then
  if ln -sf "$UV_BIN/uv" "$pi_dir/uv" 2>/dev/null && ln -sf "$UV_BIN/uvx" "$pi_dir/uvx" 2>/dev/null; then
    ok "uvx linked next to pi, in $pi_dir"
  else
    warn "Couldn't link uvx next to pi. If /mcp shows fetch as failed, open a new terminal and start pi again."
  fi
fi
if uvx mcp-server-fetch --help >/dev/null 2>&1; then ok "fetch server ready"
else warn "Couldn't download the fetch server. DAVE will still work; web pages won't."; fi

# ---------- 5. DAVE's campus-events server ----------
step "5. campus-events server"
if npm install --prefix mcp/campus-events --no-audit --no-fund --no-update-notifier --loglevel=error >/dev/null 2>&1; then
  ok "campus-events server installed"
elif [ -d mcp/campus-events/node_modules/@modelcontextprotocol/sdk ]; then
  ok "campus-events server already installed (no network, using the copy in this folder)"
else
  warn "Couldn't install campus-events. Check the network, or use the offline bundle, then run ./setup.sh again."
fi

# ---------- 6. VS Code (where you edit DAVE and run pi) ----------
step "6. VS Code"
# On a Mac, VS Code's code command lives inside the app. Link it next to uv,
# which is already on your PATH, so every terminal finds it.
link_mac_code() { # link_mac_code <path to Visual Studio Code.app>
  [ -x "$1/Contents/Resources/app/bin/code" ] && mkdir -p "$UV_BIN" && ln -sf "$1/Contents/Resources/app/bin/code" "$UV_BIN/code"
}
if ! command -v code >/dev/null 2>&1 && [ "$(uname -s)" = Darwin ]; then
  for app in "/Applications/Visual Studio Code.app" "$HOME/Applications/Visual Studio Code.app"; do
    [ -d "$app" ] && link_mac_code "$app" && ok "Added VS Code's code command, in $UV_BIN" && break
  done
  if ! command -v code >/dev/null 2>&1; then
    # Not installed: unpack it into your own Applications folder, which needs no admin.
    vscode_zip="$(mktemp "${TMPDIR:-/tmp}/vscode.XXXXXX")"
    if curl -fsSL "$VSCODE_MAC_URL" -o "$vscode_zip" && mkdir -p "$HOME/Applications" &&
       ditto -x -k "$vscode_zip" "$HOME/Applications" && link_mac_code "$HOME/Applications/Visual Studio Code.app"; then
      ok "VS Code installed in ~/Applications"
    fi
    rm -f "$vscode_zip"
  fi
  hash -r
fi
if command -v code >/dev/null 2>&1; then
  ok "VS Code is here"
elif [ "$(uname -s)" = Darwin ]; then
  warn "Couldn't install VS Code. Get it from https://code.visualstudio.com, then run ./setup.sh again."
else
  # Linux has no way to install VS Code without sudo that keeps its security sandbox on.
  warn "VS Code isn't installed, and installing it needs an administrator: sudo snap install code --classic (Ubuntu), or the .deb or .rpm from https://code.visualstudio.com. On a studio machine, ask for help."
fi

# ---------- 7. Connect to the studio ----------
step "7. Connect to the studio"
node scripts/connect.mjs

# ---------- 8. Personal coding integrations ----------
step "8. DAVE coding integrations"
node scripts/configure-dave.mjs

# ---------- Done ----------
step "Done"
# Opened from here, VS Code starts with this script's PATH, so its terminal finds pi.
# The DAVE profile starts empty: no extensions, so nothing else competes with DAVE.
# READY.md is the "you're all set" page; .vscode/settings.json shows it rendered.
# Skipped without a screen to open it on (an SSH session, for example).
has_screen() { [ "$(uname -s)" = Darwin ] || [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; }
if command -v code >/dev/null 2>&1 && has_screen && code --profile DAVE "$PWD" "$PWD/READY.md" >/dev/null 2>&1; then
  ok "Opened this folder in VS Code, in its own DAVE profile"
  printf '\nWhen it'"'"'s time, start DAVE in its terminal (Ctrl + `):\n\n  pi\n\n'
else
  printf '\nOpen this folder in VS Code (File > Open Folder), then start DAVE in its terminal (Ctrl + `):\n\n  pi\n\n'
fi
printf 'Say yes when pi asks to trust this folder.\n'
printf 'Using this terminal instead? Run  source %s  first, so it can find pi.\n' "$profile"
