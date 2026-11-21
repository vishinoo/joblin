#!/usr/bin/env bash
# Joblin installer: sets everything up and opens Joblin.
#   curl -fsSL https://raw.githubusercontent.com/vishinoo/joblin/main/install.sh | bash
# Run it again any time to update.
set -euo pipefail

REPO="https://github.com/vishinoo/joblin.git"
DIR="${JOBLIN_DIR:-$HOME/joblin}"
MODEL="${JOBLIN_MODEL:-qwen2.5:3b}"

say()  { printf "\n\033[1;34m👺 %s\033[0m\n" "$*"; }
fail() { printf "\n\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
[ "$OS" = "Darwin" ] || [ "$OS" = "Linux" ] || fail "Joblin runs on macOS and Linux. On Windows, use WSL."

brew_install() {
  if has brew; then brew install "$@"; return; fi
  return 1
}

say "Checking the goblin's tools…"

if ! has git; then
  if [ "$OS" = "Darwin" ]; then xcode-select --install 2>/dev/null || true; fail "Install the Xcode command line tools from the popup, then run this again."
  else fail "Install git first (e.g. sudo apt install git), then run this again."; fi
fi

node_ok() { has node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if ! node_ok; then
  say "Installing Node.js…"
  brew_install node || fail "Joblin needs Node.js 20 or newer. Get it from https://nodejs.org, then run this again."
  node_ok || fail "Node.js 20+ still not found. Open a new terminal and run this again."
fi

if ! has ollama; then
  say "Installing Ollama (the free local AI brain)…"
  if [ "$OS" = "Darwin" ]; then
    brew_install --cask ollama || fail "Download Ollama from https://ollama.com/download, open it once, then run this again."
  else
    curl -fsSL https://ollama.com/install.sh | sh
  fi
fi

if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  say "Waking up Ollama…"
  if [ "$OS" = "Darwin" ] && [ -d /Applications/Ollama.app ]; then open -a Ollama; else (ollama serve >/dev/null 2>&1 &); fi
  for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done
fi

say "Giving Joblin a brain ($MODEL, about 2 GB the first time)…"
ollama pull "$MODEL" || say "Couldn't download the model now. You can pick one later in Settings → AI model."

if [ -d "$DIR/.git" ]; then
  say "Joblin already lives in $DIR. Updating…"
  git -C "$DIR" pull --ff-only --autostash origin main
else
  say "Fetching Joblin into $DIR…"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
say "Installing packages…"
npm install --no-audit --no-fund
npx --yes playwright install chromium

if [ "$OS" = "Darwin" ] && [ -d "$HOME/Desktop" ]; then
  cat > "$HOME/Desktop/Joblin.command" <<EOF
#!/bin/bash
cd "$DIR" && npm start
EOF
  chmod +x "$HOME/Desktop/Joblin.command"
  say "Put a Joblin launcher on your Desktop. Double-click it to start him next time."
fi

say "All done. Starting Joblin…"
npm start
