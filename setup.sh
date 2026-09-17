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
    sudo apt-get update -y
    sudo apt-get install -y git
  fi
  if [ -d "$REPO_DIRNAME" ]; then
    echo "-> $REPO_DIRNAME already exists, pulling latest instead of re-cloning"
    (cd "$REPO_DIRNAME" && git pull)
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

# 3. Allow the dashboard to shut the Pi down automatically without a password prompt
SUDOERS_FILE="/etc/sudoers.d/squadron-dashboard-shutdown"
if [ ! -f "$SUDOERS_FILE" ]; then
  echo "-> Granting passwordless shutdown permission (needed for auto-off)..."
  echo "$SERVICE_USER ALL=(ALL) NOPASSWD: /sbin/shutdown" | sudo tee "$SUDOERS_FILE" > /dev/null
  sudo chmod 0440 "$SUDOERS_FILE"
fi

# 3b. Allow the dashboard to restart its own systemd service without a password
#     prompt, so it can apply auto-updates pulled from GitHub without you doing anything
UPDATE_SUDOERS_FILE="/etc/sudoers.d/squadron-dashboard-restart"
if [ ! -f "$UPDATE_SUDOERS_FILE" ]; then
  echo "-> Granting passwordless restart permission (needed for auto-update)..."
  echo "$SERVICE_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart squadron-dashboard.service" | sudo tee "$UPDATE_SUDOERS_FILE" > /dev/null
  sudo chmod 0440 "$UPDATE_SUDOERS_FILE"
else
  echo "-> Restart permission already configured"
fi

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
echo
echo "To point Chromium at it in kiosk mode on boot, see 'Kiosk autostart' in README.md."
echo "To check on the service later:  sudo systemctl status squadron-dashboard"
echo "To view logs:                    journalctl -u squadron-dashboard -f"
