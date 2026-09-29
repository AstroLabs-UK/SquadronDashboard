#!/usr/bin/env bash
# Squadron Dashboard - one-command setup (setup.sh just calls this script)
#
# Works two ways:
#   1. curl -fsSL https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/Stable/install.sh | bash
#   2. git clone … && cd SquadronDashboard && ./install.sh
#
# First run shows an interactive menu (Chromium, desktop, theme, PIN).
# Re-runs skip the menu. Force non-interactive: INSTALL_NONINTERACTIVE=1 ./install.sh
# or: ./install.sh --yes
set -e

REPO_URL="https://github.com/AstroLabs-UK/SquadronDashboard.git"
REPO_DIRNAME="SquadronDashboard"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || pwd)"

NONINTERACTIVE=0
if [ "${INSTALL_NONINTERACTIVE:-0}" = "1" ]; then NONINTERACTIVE=1; fi
for arg in "$@"; do
  case "$arg" in --yes|-y|--noninteractive) NONINTERACTIVE=1 ;; esac
done
# No terminal attached → cannot ask questions
if [ ! -t 0 ]; then NONINTERACTIVE=1; fi

if [ -f "$SCRIPT_DIR/package.json" ]; then
  DIR="$SCRIPT_DIR"
else
  echo "== Squadron Dashboard setup =="
  echo "-> Not running from inside the repo - cloning it first..."
  if ! command -v git >/dev/null 2>&1; then
    echo "-> Git not found, installing..."
    sudo apt-get update -y
    sudo apt-get install -y git
  else
    echo "-> Using existing local Git installation ($(git --version 2>/dev/null | head -1))"
  fi
  if [ -d "$REPO_DIRNAME" ]; then
    echo "-> $REPO_DIRNAME already exists, pulling latest instead of re-cloning"
    (cd "$REPO_DIRNAME" && git config --global --add safe.directory "$(pwd)" 2>/dev/null || true
     git config core.filemode false 2>/dev/null || true
     git fetch --quiet && (git reset --hard --quiet '@{u}' 2>/dev/null || git pull --ff-only || git pull))
  else
    git clone "$REPO_URL" "$REPO_DIRNAME"
  fi
  DIR="$(cd "$REPO_DIRNAME" && pwd)"
fi

SERVICE_USER="$(whoami)"
SETUP_MARKER="$DIR/data/.setup-done"

echo "== Squadron Dashboard setup =="
echo "Working directory: $DIR"
echo "Running as user:   $SERVICE_USER"
echo

if command -v git >/dev/null 2>&1 && [ -d "$DIR/.git" ]; then
  git -C "$DIR" config --global --add safe.directory "$DIR" 2>/dev/null || true
  git -C "$DIR" config core.filemode false 2>/dev/null || true
fi

# ---------- First-run interactive choices ----------
WANT_CHROMIUM=0
WANT_DESKTOP=0
CHOICE_THEME="rafac"
CHOICE_PIN=""   # empty = generate random later

is_first_setup() {
  [ ! -f "$SETUP_MARKER" ]
}

ask_yn() {
  # $1 prompt  $2 default y/n
  local prompt="$1" def="$2" ans
  while true; do
    read -r -p "$prompt [${def}]: " ans || ans=""
    ans="${ans:-$def}"
    case "$ans" in
      y|Y|yes|Yes|YES) return 0 ;;
      n|N|no|No|NO) return 1 ;;
      *) echo "  Please answer y or n." ;;
    esac
  done
}

if is_first_setup && [ "$NONINTERACTIVE" = "1" ] && [ ! -t 0 ]; then
  echo
  echo "NOTE: Install was started without an interactive terminal (e.g. curl | bash)."
  echo "      The first-time menu was skipped. For the menu, run:"
  echo "        curl -fsSL .../install.sh -o install.sh && bash install.sh"
  echo "      Or:  bash $DIR/install.sh"
  echo
fi

if is_first_setup && [ "$NONINTERACTIVE" = "0" ]; then
  echo "First-time setup — answer a few questions (re-running install later skips this)."
  echo

  if ask_yn "Install Chromium for full-screen kiosk display?" "y"; then
    WANT_CHROMIUM=1
  fi

  if ask_yn "Install a desktop environment? (needed on Raspberry Pi OS Lite)" "n"; then
    WANT_DESKTOP=1
  fi

  echo
  echo "Unit theme (colours, crest, Chain of Command ranks):"
  echo "  1) RAF Air Cadets (RAFAC / ATC)   [default]"
  echo "  2) Army Cadets (ACF)"
  echo "  3) Sea Cadets (SCC)"
  echo "  4) Combined Cadet Force (CCF)"
  echo "  5) Volunteer Cadet Corps (VCC)"
  read -r -p "Choose 1-5 [1]: " theme_n || theme_n=""
  theme_n="${theme_n:-1}"
  case "$theme_n" in
    2) CHOICE_THEME="acf" ;;
    3) CHOICE_THEME="scc" ;;
    4) CHOICE_THEME="ccf" ;;
    5) CHOICE_THEME="vcc" ;;
    *) CHOICE_THEME="rafac" ;;
  esac
  echo "-> Theme: $CHOICE_THEME"

  echo
  echo "Editor PIN (protects /edit — you will need this later)"
  while true; do
    read -r -s -p "Enter PIN (4+ characters): " CHOICE_PIN; echo
    read -r -s -p "Type it again: " pin2; echo
    if [ "${#CHOICE_PIN}" -lt 4 ]; then
      echo "  PIN must be at least 4 characters."
      continue
    fi
    if [ "$CHOICE_PIN" != "$pin2" ]; then
      echo "  Entries did not match — try again."
      continue
    fi
    break
  done
  echo "-> PIN will be saved for /edit"
  echo
elif is_first_setup && [ "$NONINTERACTIVE" = "1" ]; then
  echo "-> Non-interactive first setup (defaults: no Chromium, no desktop, RAFAC theme)"
  if [ -n "${EDIT_PIN:-}" ]; then
    CHOICE_PIN="$EDIT_PIN"
    echo "-> Using EDIT_PIN from environment"
  else
    echo "-> No EDIT_PIN set — a random 6-digit PIN will be generated"
  fi
  echo "   Tip: run install from a terminal without --yes to choose Chromium, theme, and PIN."
else
  echo "-> Existing install detected (skipping first-time questions)"
fi

# ---------- Packages ----------
if ! command -v node >/dev/null 2>&1; then
  echo "-> Node.js not found, installing..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "-> Node.js already installed ($(node -v))"
fi

if [ "$WANT_DESKTOP" = "1" ]; then
  echo "-> Installing desktop packages (this can take a long time on Pi OS Lite)..."
  echo "   If this fails, use: sudo raspi-config → System Options → Boot / Auto Login → Desktop"
  sudo apt-get update -y || true
  DESK_OK=0
  if apt-cache show raspberrypi-ui-mods >/dev/null 2>&1; then
    if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y raspberrypi-ui-mods xserver-xorg lightdm; then
      DESK_OK=1
    fi
  fi
  if [ "$DESK_OK" != "1" ]; then
    if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y xserver-xorg xinit lightdm 2>/dev/null; then
      DESK_OK=1
      echo "-> Installed a minimal X11 + lightdm stack (not a full Pi desktop)."
    fi
  fi
  if [ "$DESK_OK" != "1" ]; then
    echo "!! Desktop packages could not be installed automatically."
    echo "   The dashboard server will still run. Use raspi-config for a desktop if needed."
  else
    echo "-> Desktop packages installed. A reboot may be required before a GUI appears."
  fi
fi

if [ "$WANT_CHROMIUM" = "1" ]; then
  echo "-> Installing Chromium..."
  sudo apt-get update -y
  CHROMIUM_OK=0
  for pkg in chromium chromium-browser; do
    if apt-cache show "$pkg" >/dev/null 2>&1; then
      if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$pkg"; then
        CHROMIUM_OK=1
        echo "-> Installed package: $pkg"
        break
      fi
    fi
  done
  if [ "$CHROMIUM_OK" != "1" ]; then
    echo "!! Chromium could not be installed automatically."
    echo "   Try:  sudo apt-get install -y chromium"
    echo "     or:  sudo apt-get install -y chromium-browser"
    WANT_CHROMIUM=0
  fi
fi

echo "-> Installing npm dependencies..."
cd "$DIR"
npm install --omit=dev

# ---------- First-run theme into data.json ----------
mkdir -p "$DIR/data"
if is_first_setup; then
  python3 - <<PY
import json, os
p = os.path.join("$DIR", "data", "data.json")
theme = "$CHOICE_THEME"
if os.path.exists(p):
    try:
        d = json.load(open(p))
    except Exception:
        d = {}
else:
    d = {}
if not d.get("theme"):
    d["theme"] = theme
    print("-> Theme written to data.json:", theme)
else:
    print("-> Keeping existing theme in data.json:", d.get("theme"))
if "widgets" not in d:
    d["widgets"] = {"leaderboard": True, "news": True, "events": True, "instagram": True, "uniform": True, "chainOfCommand": False}
json.dump(d, open(p, "w"), indent=2)
PY
fi

# ---------- Auto shutdown ----------
echo "-> Setting up auto-shutdown (reads the duration from data.json at boot)..."
cat > "$DIR/shutdown-timer.sh" <<EOF
#!/usr/bin/env bash
# Reads autoShutdownMinutes + autoShutdownMode from settings (set on /edit).
# sleep  = display blanks itself; this script exits without powering off.
# poweroff = wait then /sbin/shutdown -h now
eval "\$(python3 -c "
import json, os
p = '$DIR/data/data.json'
if not os.path.exists(p):
    p = '$DIR/data.json'
mins, mode = 165, 'sleep'
try:
    d = json.load(open(p))
    mins = int(d.get('autoShutdownMinutes', 165))
    mode = d.get('autoShutdownMode') or 'sleep'
except Exception:
    pass
if mode not in ('sleep', 'poweroff'):
    mode = 'sleep'
print('MINUTES=%d' % max(1, mins))
print('MODE=%s' % mode)
")"
if [ "\$MODE" = "sleep" ]; then
  echo "Squadron Dashboard: sleep mode (black screen on the display) — not powering off"
  exit 0
fi
echo "Squadron Dashboard: shutting down in \${MINUTES} minutes (set on /edit)"
sleep "\$((MINUTES * 60))"
/sbin/shutdown -h now
EOF
chmod +x "$DIR/shutdown-timer.sh"

sudo tee /etc/systemd/system/squadron-dashboard-shutdown.service > /dev/null <<EOF
[Unit]
Description=Squadron Dashboard auto shutdown (duration set on /edit)

[Service]
Type=simple
ExecStart=$DIR/shutdown-timer.sh

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now squadron-dashboard-shutdown.service

# ---------- Auto update ----------
echo "-> Setting up auto-update (checks every 30 minutes)..."
cat > "$DIR/npm-update.sh" <<EOF
#!/usr/bin/env bash
exec bash "$DIR/update.sh"
EOF
chmod +x "$DIR/npm-update.sh"

sudo tee /etc/systemd/system/squadron-dashboard-update.service > /dev/null <<EOF
[Unit]
Description=Squadron Dashboard auto update check
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR
ExecStart=$DIR/npm-update.sh
EOF
sudo tee /etc/systemd/system/squadron-dashboard-update.timer > /dev/null <<'EOF'
[Unit]
Description=Run Squadron Dashboard update check every 30 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=30min
Persistent=true

[Install]
WantedBy=timers.target
EOF
# path unit may already exist from previous installs — recreate lightly
if [ -f "$DIR/update.sh" ]; then
  sudo systemctl daemon-reload
  sudo systemctl enable --now squadron-dashboard-update.timer 2>/dev/null || true
fi

# ---------- sqndash on PATH (works from any directory) ----------
sudo tee /usr/local/bin/sqndash > /dev/null <<EOF
#!/usr/bin/env bash
exec bash "$DIR/sqndash.sh" "\$@"
EOF
sudo chmod +x /usr/local/bin/sqndash

# ---------- Main service ----------
SERVICE_FILE="/etc/systemd/system/squadron-dashboard.service"
echo "-> Installing systemd service..."
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Squadron Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable squadron-dashboard.service
sudo systemctl restart squadron-dashboard.service

echo "-> Checking that the dashboard responds..."
SMOKE_OK=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:3000/healthz" 2>/dev/null \
     || curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:3000/" 2>/dev/null; then
    SMOKE_OK=1
    break
  fi
  sleep 1
done
if [ "$SMOKE_OK" = "1" ]; then
  echo "-> Smoke test OK (http://127.0.0.1:3000)"
else
  echo "!! Smoke test: dashboard did not respond on :3000 yet."
  echo "   Check:  sudo systemctl status squadron-dashboard"
  echo "   Logs:   journalctl -u squadron-dashboard -n 50 --no-pager"
fi

# ---------- Optional kiosk autostart ----------
if [ "$WANT_CHROMIUM" = "1" ]; then
  echo "-> Adding Chromium kiosk autostart (for desktop sessions)..."
  AUTODIR="$HOME/.config/autostart"
  mkdir -p "$AUTODIR"
  BROWSER="$(command -v chromium-browser || command -v chromium || true)"
  if [ -n "$BROWSER" ]; then
    cat > "$AUTODIR/squadron-dashboard-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Squadron Dashboard Kiosk
Exec=$DIR/scripts/kiosk-wait-display.sh
X-GNOME-Autostart-enabled=true
EOF
    # Ensure kiosk script uses password-store=basic
    if [ -f "$DIR/scripts/kiosk-wait-display.sh" ]; then
      chmod +x "$DIR/scripts/kiosk-wait-display.sh"
    fi
    echo "-> Kiosk autostart written to $AUTODIR/squadron-dashboard-kiosk.desktop"
  fi
fi

# ---------- Editor PIN ----------
mkdir -p "$DIR/data"
if [ ! -s "$DIR/data/edit-pin" ]; then
  if [ -n "$CHOICE_PIN" ]; then
    NEW_PIN="$CHOICE_PIN"
  elif [ -n "${EDIT_PIN:-}" ]; then
    NEW_PIN="$EDIT_PIN"
  else
    NEW_PIN="$(tr -dc '0-9' < /dev/urandom | head -c 6)"
  fi
  ( umask 077; printf '%s\n' "$NEW_PIN" > "$DIR/data/edit-pin" )
  echo
  echo "=============================================================="
  if [ -n "$CHOICE_PIN" ] || [ -n "${EDIT_PIN:-}" ]; then
    echo "  Editor PIN saved (the one you set during setup)."
  else
    echo "  Your generated /edit PIN is:  $NEW_PIN"
    echo "  Write it down — change later with: sqndash --set-pin"
  fi
  echo "  Open http://<this-device>:3000/edit and enter the PIN."
  echo "=============================================================="
else
  echo "-> Editor PIN already set (change it with: sqndash --set-pin)"
fi

# Mark first-time setup complete (skips menu on next install.sh)
touch "$SETUP_MARKER"

echo
echo "== Setup complete =="
echo "The dashboard is running and will start automatically on boot."
echo
echo "  Display:  http://localhost:3000"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "  Edit:     http://${IP:-<device-ip>}:3000/edit"
echo "  Status:   http://${IP:-<device-ip>}:3000/status"
echo
echo "  Type  sqndash  anywhere for the command list."
echo "  Update:  sqndash --update"
echo "  Logs:    journalctl -u squadron-dashboard -f"
