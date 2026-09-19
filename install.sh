#!/usr/bin/env bash
# Squadron Dashboard - one-command setup
#
# Works two ways:
#   1. curl -fsSL https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/main/setup.sh | bash
#      (clones the repo for you, then installs and configures everything)
#   2. git clone https://github.com/AstroLabs-UK/SquadronDashboard.git && cd SquadronDashboard && ./setup.sh
#      (already have the repo - just installs and configures)
set -e

REPO_URL="https://github.com/AstroLabs-UK/SquadronDashboard.git"
REPO_DIRNAME="SquadronDashboard"

# Work out whether we're running from inside an already-cloned copy of the repo
# (package.json sits next to this script) or were piped straight into bash
# (curl | bash), in which case there is no "next to this script" - clone first.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || pwd)"

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

echo "== Squadron Dashboard setup =="
echo "Working directory: $DIR"
echo "Running as user:   $SERVICE_USER"
echo

# Ensure local Git (if present) treats this folder as safe and ignores file-mode noise
if command -v git >/dev/null 2>&1 && [ -d "$DIR/.git" ]; then
  git -C "$DIR" config --global --add safe.directory "$DIR" 2>/dev/null || true
  git -C "$DIR" config core.filemode false 2>/dev/null || true
fi

# 1. Install Node.js if it's missing
if ! command -v node >/dev/null 2>&1; then
  echo "-> Node.js not found, installing..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "-> Node.js already installed ($(node -v))"
fi

# 2. Install dependencies (this is the one step that needs internet - after this,
#    the whole folder including node_modules is portable and works offline)
echo "-> Installing dependencies..."
cd "$DIR"
npm install --omit=dev

# 3. Auto shutdown - configurable duration after every boot (set on /edit as
#    "Auto shutdown after (minutes)", read fresh from data.json at every boot),
#    a plain host-level timer so it works the same whether the app is healthy,
#    crashed, or mid-restart
echo "-> Setting up auto-shutdown (reads the duration from data.json at boot)..."
cat > "$DIR/shutdown-timer.sh" <<EOF
#!/usr/bin/env bash
MINUTES=\$(python3 -c "
import json
import os
p = '$DIR/data/data.json'
if not os.path.exists(p):
    p = '$DIR/data.json'
try:
    d = json.load(open(p))
    print(int(d.get('autoShutdownMinutes', 165)))
except Exception:
    print(165)
")
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

# 3b. Auto update - checks this repo 2 minutes after every boot and then every 30
#     minutes, applies new commits and restarts the service. Custom settings
#     (data.json) are preserved - see update.sh
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

[Install]
WantedBy=timers.target
EOF

# The update script needs passwordless permission to restart the service -
# scoped to that one specific command only.
UPDATE_SUDOERS_FILE="/etc/sudoers.d/squadron-dashboard-restart"
if [ ! -f "$UPDATE_SUDOERS_FILE" ]; then
  echo "$SERVICE_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart squadron-dashboard.service" | sudo tee "$UPDATE_SUDOERS_FILE" > /dev/null
  sudo chmod 0440 "$UPDATE_SUDOERS_FILE"
fi

# "Force update" button on /edit: the web page drops data/update-request.json and this path
# unit notices it and runs the update service right away (the timer above stays as normal).
mkdir -p "$DIR/data"
sudo tee /etc/systemd/system/squadron-dashboard-update.path > /dev/null <<EOF
[Unit]
Description=Squadron Dashboard - update now when requested from /edit

[Path]
PathExists=$DIR/data/update-request.json

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now squadron-dashboard-update.timer
sudo systemctl enable --now squadron-dashboard-update.path

# The `sqndash` command - works from any folder:  sqndash --update
sudo tee /usr/local/bin/sqndash > /dev/null <<EOF
#!/usr/bin/env bash
exec bash "$DIR/sqndash.sh" "\$@"
EOF
sudo chmod +x /usr/local/bin/sqndash

# 4. Set up a systemd service so the dashboard starts automatically on boot
#    and restarts itself if it ever crashes
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
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable squadron-dashboard.service
sudo systemctl restart squadron-dashboard.service

echo
echo "== Setup complete =="
echo "The dashboard is running and will start automatically every time this device boots."
echo
echo "  Display:  http://localhost:3000"
echo "  Edit (from any phone/laptop on the network): http://$(hostname -I | awk '{print $1}'):3000/edit"
echo "  Status:   http://$(hostname -I | awk '{print $1}'):3000/status"
echo
echo "To point Chromium at it in kiosk mode on boot, see 'Kiosk autostart' in README.md."
echo "To update to the latest version any time:  sqndash --update"
echo "To check on the service later:  sudo systemctl status squadron-dashboard"
echo "To view logs:                    journalctl -u squadron-dashboard -f"
