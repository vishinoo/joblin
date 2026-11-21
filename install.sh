#!/usr/bin/env bash
# Joblin installer: sets everything up and opens Joblin.
#   curl -fsSL https://raw.githubusercontent.com/vishinoo/joblin/main/install.sh | bash
# Run it again any time to update. Needs no admin password, Homebrew or git.
set -euo pipefail

REPO="vishinoo/joblin"
DIR="${JOBLIN_DIR:-$HOME/joblin}"
MODEL="${JOBLIN_MODEL:-qwen2.5:3b}"
RUNTIME="$DIR/.runtime"

say()  { printf "\n\033[1;34m👺 %s\033[0m\n" "$*"; }
note() { printf "   %s\n" "$*"; }
fail() { printf "\n\033[1;31m✗ %s\033[0m\n\n" "$*" >&2; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in Darwin) PLAT=darwin ;; Linux) PLAT=linux ;; *) fail "Joblin runs on Mac and Linux. On Windows, install WSL first." ;; esac
case "$ARCH" in arm64|aarch64) NARCH=arm64 ;; x86_64|amd64) NARCH=x64 ;; *) fail "Unsupported processor: $ARCH" ;; esac

main() {
say "Hi! I'm Joblin. Setting up takes about 10 minutes, mostly downloading."
note "Keep this window open. You don't need to type anything else."
mkdir -p "$DIR" "$RUNTIME"

# ---------- 1. Node.js (Joblin's engine) ----------
node_ok() { has node && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; }
export PATH="$RUNTIME/node/bin:$PATH"
if ! node_ok; then
  say "Step 1 of 4: Downloading Node.js (Joblin's engine)…"
  BASE="https://nodejs.org/dist/latest-v22.x"
  FILE="$(curl -fsSL "$BASE/SHASUMS256.txt" | awk '{print $2}' | grep -E "^node-v[0-9.]+-$PLAT-$NARCH\.tar\.gz$" | head -1)"
  [ -n "$FILE" ] || fail "Couldn't find Node.js for this computer. Check your internet connection and try again."
  rm -rf "$RUNTIME/node" && mkdir -p "$RUNTIME/node"
  curl -fL# "$BASE/$FILE" | tar -xz -C "$RUNTIME/node" --strip-components=1
  node_ok || fail "Node.js didn't install correctly. Try running this again."
else
  say "Step 1 of 4: Node.js is already here. ✓"
fi

# ---------- 2. Joblin itself ----------
real_git() { [ -z "${JOBLIN_NO_GIT:-}" ] && has git && { [ "$PLAT" != darwin ] || xcode-select -p >/dev/null 2>&1; }; }  # macOS ships a git stub that pops up an installer
if [ -d "$DIR/.git" ] && real_git; then
  say "Step 2 of 4: Updating Joblin…"
  git -C "$DIR" pull --ff-only --autostash origin main
elif [ ! -f "$DIR/package.json" ] && real_git; then
  say "Step 2 of 4: Downloading Joblin…"
  tmp="$(mktemp -d)"; git clone --depth 1 "https://github.com/$REPO.git" "$tmp/joblin"
  cp -R "$tmp/joblin/." "$DIR/"; rm -rf "$tmp"
else
  say "Step 2 of 4: Downloading Joblin…"
  SHA="$(curl -fsSL "https://api.github.com/repos/$REPO/commits/main" | grep -m1 '"sha"' | sed -E 's/.*"([0-9a-f]{40})".*/\1/')"
  [ -n "$SHA" ] || fail "Couldn't reach GitHub. Check your internet connection and try again."
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$SHA" | tar -xz -C "$DIR" --strip-components=1
  echo "$SHA" > "$DIR/.joblin-version"
fi
cd "$DIR"
note "Installing Joblin's parts (a minute or two)…"
npm install --no-audit --no-fund --loglevel=error </dev/null
npx --yes playwright install chromium </dev/null >/dev/null

# ---------- 3. Ollama (the free AI that runs on your computer) ----------
ollama_up() { curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; }
if ! ollama_up; then
  if [ "$PLAT" = darwin ]; then
    APP=""
    for d in /Applications "$HOME/Applications"; do [ -d "$d/Ollama.app" ] && APP="$d/Ollama.app"; done
    if [ -z "$APP" ]; then
      say "Step 3 of 4: Downloading Ollama (the free AI brain)…"
      DEST=/Applications; [ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
      tmp="$(mktemp -d)"; curl -fL# -o "$tmp/Ollama.zip" https://ollama.com/download/Ollama-darwin.zip
      ditto -x -k "$tmp/Ollama.zip" "$DEST"; rm -rf "$tmp"; APP="$DEST/Ollama.app"
      note "Ollama opens now. If it asks to install its command line tool, you can click Skip or Not now."
    else
      say "Step 3 of 4: Starting Ollama…"
    fi
    open "$APP"
  else
    if ! has ollama; then say "Step 3 of 4: Installing Ollama (it may ask for your password)…"; curl -fsSL https://ollama.com/install.sh | sh; fi
    (ollama serve >/dev/null 2>&1 &)
  fi
  for _ in $(seq 1 60); do ollama_up && break; sleep 1; done
  ollama_up || fail "Ollama didn't start. Open the Ollama app yourself, then run this again."
else
  say "Step 3 of 4: Ollama is already running. ✓"
fi

# ---------- 4. The AI model ----------
if curl -fsS http://127.0.0.1:11434/api/tags | grep -q "\"$MODEL\""; then
  say "Step 4 of 4: Joblin's brain is already downloaded. ✓"
else
  say "Step 4 of 4: Downloading Joblin's brain ($MODEL, about 2 GB)…"
  curl -fsS --no-buffer http://127.0.0.1:11434/api/pull -d "{\"model\":\"$MODEL\"}" | node -e '
    let last = -1; require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
      try { const j = JSON.parse(l); if (j.error) { console.error("\n   " + j.error); process.exitCode = 1; }
        if (j.total && j.completed) { const p = Math.floor((j.completed / j.total) * 100); if (p !== last) { last = p; process.stdout.write(`\r   ${p}%   `); } } } catch {} })
    .on("close", () => console.log("\r   done   "));' || note "Couldn't download it now. You can pick a model later in Settings → AI model."
fi

# ---------- Launcher ----------
if [ "$PLAT" = darwin ] && [ -d "$HOME/Desktop" ] && [ -z "${JOBLIN_TEST:-}" ]; then
  cat > "$HOME/Desktop/Joblin.command" <<EOF
#!/bin/bash
# Double-click to start Joblin. Close this window to stop him.
export PATH="$RUNTIME/node/bin:\$PATH"
cd "$DIR" && npm start
EOF
  chmod +x "$HOME/Desktop/Joblin.command"
  say "Added a Joblin launcher to your Desktop. Next time, just double-click it."
fi

[ -n "${JOBLIN_TEST:-}" ] && { say "Test mode: done."; return; }
say "All set! Joblin is opening now."
note "Keep this window open while Joblin works. Close it to stop him."
exec npm start </dev/null
}

main "$@"
