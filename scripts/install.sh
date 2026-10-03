#!/usr/bin/env bash
# Installs Sotto and registers its background services. Safe to re-run (that's also how you update).
#
#   ./scripts/install.sh                               localhost only, no password needed
#   SOTTO_HOST=sotto.example.com ./scripts/install.sh  also serve https://sotto.example.com on this Mac
#
# Services (launchd):
#   com.sotto.engine  Phonon-2 speech engine on 127.0.0.1:$SOTTO_ENGINE_PORT
#   com.sotto.web     Sotto's server and UI on 127.0.0.1:$SOTTO_PORT
#   com.sotto.proxy   only with SOTTO_HOST: Caddy serving that name over HTTPS, as a root daemon
#                     (macOS only lets root bind :443 on 127.0.0.1)
#
# Choices are saved to ~/Library/Application Support/sotto/config.env and reused on the next run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$HOME/Library/Application Support/sotto"
CONFIG="$DATA/config.env"
LA="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/sotto"
UID_="$(id -u)"
FERMION_VERSION="0.2.7" # the engine release Sotto is tested against

say() { printf '\033[1m%s\033[0m\n' "$*"; }
setting() { # value from the environment, else config.env, else the default
  local key=$1 default=${2:-} line
  if [ -n "${!key:-}" ]; then printf '%s' "${!key}"; return; fi
  line=$(grep -E "^$key=" "$CONFIG" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  line=${line#\"}; line=${line%\"}
  printf '%s' "${line:-$default}"
}
save_setting() { # key value: replace or append in config.env (owner-only)
  local key=$1 value=$2 tmp
  mkdir -p "$DATA"; touch "$CONFIG"; chmod 600 "$CONFIG"
  tmp=$(mktemp); grep -vE "^$key=" "$CONFIG" > "$tmp" || true
  printf '%s="%s"\n' "$key" "$value" >> "$tmp"; mv "$tmp" "$CONFIG"; chmod 600 "$CONFIG"
}

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "Sotto needs an Apple-silicon Mac."; exit 1; }
command -v brew >/dev/null || { echo "Homebrew is required: https://brew.sh"; exit 1; }

say "Installing dependencies"
for pkg in ffmpeg uv; do command -v $pkg >/dev/null || brew install $pkg; done
command -v bun >/dev/null || brew install oven-sh/bun/bun
if ! uv tool list 2>/dev/null | grep -q "^fermion-research v$FERMION_VERSION"; then
  # MLX extras are Apple-silicon-only, so fermion-research doesn't pull them in itself.
  uv tool install --force --python 3.12 "fermion-research==$FERMION_VERSION" \
    --with mlx --with mlx-audio --with mlx-lm --with soundfile --with scipy --with zstandard
fi
say "Downloading the Phonon-2 model (164 MB, once)"
phonon transcribe phonon-2 --download-only >/dev/null 2>&1 || echo "  download failed; the engine will retry when it starts"

say "Building the app"
(cd "$ROOT/server" && bun install --frozen-lockfile --silent)
(cd "$ROOT/web" && bun install --frozen-lockfile --silent && bun run build >/dev/null)

PORT=$(setting SOTTO_PORT 8011)
ENGINE_PORT=$(setting SOTTO_ENGINE_PORT 8010)
HOST=$(setting SOTTO_HOST "")
save_setting SOTTO_PORT "$PORT"
save_setting SOTTO_ENGINE_PORT "$ENGINE_PORT"
save_setting SOTTO_HOST "$HOST"

# Clean-up is opt-in. Ask once, on a terminal, if nothing has been chosen yet.
if ! grep -qE "^SOTTO_CLEANUP=" "$CONFIG" && [ -z "${SOTTO_CLEANUP:-}" ]; then
  choice=off
  options=()
  command -v claude >/dev/null && options+=("claude:Claude (sends text to Anthropic with your Claude Code sign-in)")
  command -v codex >/dev/null && options+=("codex:Codex (sends text to OpenAI with your Codex sign-in)")
  if [ -t 0 ] && [ ${#options[@]} -gt 0 ]; then
    echo
    echo "Optional: tidy transcripts after they're transcribed (removes filler words and stutters,"
    echo "fixes punctuation). Only the text is sent, never the audio."
    echo "  1) No"
    for i in "${!options[@]}"; do echo "  $((i + 2))) ${options[$i]#*:}"; done
    read -r -p "Choose [1]: " answer
    if [[ "$answer" =~ ^[0-9]+$ ]] && [ "$answer" -ge 2 ] && [ "$answer" -le $((${#options[@]} + 1)) ]; then
      choice=${options[$((answer - 2))]%%:*}
    fi
  fi
  save_setting SOTTO_CLEANUP "$choice"
  [ "$choice" = off ] && echo "  Clean-up is off. You can choose a provider (including local models) in Settings."
elif [ -n "${SOTTO_CLEANUP:-}" ]; then
  save_setting SOTTO_CLEANUP "$SOTTO_CLEANUP"
fi

xml() { local s=${1//&/&amp;}; s=${s//</&lt;}; printf '%s' "${s//>/&gt;}"; }

agent() { # label, log, args...
  local label=$1 log=$2; shift 2
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo "<plist version=\"1.0\"><dict>"
    echo "  <key>Label</key><string>$label</string>"
    echo "  <key>ProgramArguments</key><array>"
    for a in "$@"; do echo "    <string>$(xml "$a")</string>"; done
    echo "  </array>"
    echo "  <key>EnvironmentVariables</key><dict>"
    echo "    <key>PATH</key><string>$(xml "/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin")</string>"
    # The engine has its own service; the web server must not start a second one at login.
    echo "    <key>SOTTO_MANAGED</key><string>1</string>"
    echo "  </dict>"
    echo "  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>"
    echo "  <key>StandardOutPath</key><string>$(xml "$log")</string><key>StandardErrorPath</key><string>$(xml "$log")</string>"
    echo "</dict></plist>"
  } > "$LA/$label.plist"
  launchctl bootout "gui/$UID_/$label" 2>/dev/null || true
  while launchctl print "gui/$UID_/$label" >/dev/null 2>&1; do sleep 0.2; done
  launchctl bootstrap "gui/$UID_" "$LA/$label.plist"
}

say "Starting services"
mkdir -p "$LA" "$LOGS"
agent com.sotto.engine "$LOGS/engine.log" "$(command -v phonon)" serve --port "$ENGINE_PORT"
agent com.sotto.web    "$LOGS/web.log"    "$(command -v bun)" "$ROOT/server/src/index.ts"

printf "Waiting for the engine"
for i in $(seq 1 180); do
  curl -s "localhost:$PORT/api/health" | grep -q '"engine":true' && break
  [ "$i" = 180 ] && { echo; echo "The engine didn't start within 3 minutes. See $LOGS/engine.log"; exit 1; }
  printf .; sleep 1
done
echo

if [ -n "$HOST" ]; then
  # Optional HTTPS name: hosts entry, Caddy daemon and its local CA. Needs your password.
  CADDY_DATA="/Library/Application Support/sotto-caddy"
  CADDYFILE="$CADDY_DATA/Caddyfile" # root-owned copy: the daemon never reads a user-writable config
  CA="$CADDY_DATA/pki/authorities/local/root.crt"
  DAEMON=/Library/LaunchDaemons/com.sotto.proxy.plist
  ca_trusted() {
    sudo test -f "$CA" || return 1
    local fp
    fp=$(sudo openssl x509 -in "$CA" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)
    security find-certificate -a -Z -c "Caddy Local Authority" /Library/Keychains/System.keychain 2>/dev/null | grep -q "SHA-1 hash: $fp"
  }

  say "Setting up https://$HOST (asks for your password)"
  command -v caddy >/dev/null || brew install caddy
  sudo -v
  sudo mkdir -p "$CADDY_DATA"
  sudo install -m 644 -o root -g wheel "$ROOT/Caddyfile" "$CADDYFILE"
  # Each entry is tagged "# sotto" so it can be replaced or removed exactly.
  if ! grep -qE "^127\.0\.0\.1[[:space:]]+$HOST[[:space:]]+# sotto$" /etc/hosts; then
    sudo sed -i '' -e '/# sotto$/d' -e '/^# sotto (local only)$/d' -e "/[[:space:]]$HOST\$/d" /etc/hosts
    printf '127.0.0.1 %s # sotto\n::1 %s # sotto\n' "$HOST" "$HOST" | sudo tee -a /etc/hosts >/dev/null
    sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder 2>/dev/null || true
  fi

  TMP=$(mktemp)
  cat > "$TMP" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.sotto.proxy</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v caddy)</string><string>run</string>
    <string>--config</string><string>$CADDYFILE</string><string>--adapter</string><string>caddyfile</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>/var/root</string>
    <key>XDG_CONFIG_HOME</key><string>$CADDY_DATA/config</string>
    <key>XDG_DATA_HOME</key><string>$CADDY_DATA</string>
    <key>SOTTO_HOST</key><string>$(xml "$HOST")</string>
    <key>SOTTO_PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Library/Logs/sotto-proxy.log</string>
  <key>StandardErrorPath</key><string>/Library/Logs/sotto-proxy.log</string>
</dict></plist>
PLIST
  if ! sudo cmp -s "$TMP" "$DAEMON"; then
    sudo launchctl bootout system/com.sotto.proxy 2>/dev/null || true
    while sudo launchctl print system/com.sotto.proxy >/dev/null 2>&1; do sleep 0.2; done
    sudo install -m 644 -o root -g wheel "$TMP" "$DAEMON"
    sudo launchctl bootstrap system "$DAEMON"
  else
    sudo launchctl kickstart -k system/com.sotto.proxy
  fi
  rm -f "$TMP"
  for _ in $(seq 1 40); do sudo test -f "$CA" && break; sleep 0.25; done
  ca_trusted || sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$CA"
  echo
  say "Sotto is running at https://$HOST (and http://localhost:$PORT)"
else
  echo
  say "Sotto is running at http://localhost:$PORT"
  echo "Tip: in Safari, File → Add to Dock makes it an app."
fi
