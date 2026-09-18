#!/usr/bin/env bash
# Squadron Dashboard - one-command Docker install
#
#   curl -fsSL https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/main/install.sh | bash
#
# From a fresh Raspberry Pi OS install, this single command:
#   - installs Docker (if not already present)
#   - clones this repo (if not already present)
#   - builds and starts the dashboard in a container
#   - installs Chromium (if needed) and points it at the dashboard in kiosk
#     mode, launching automatically on every boot
#   - sets up auto-shutdown (2h45m after boot) and auto-update (checks this
#     repo every 30 minutes) - both run on the host via systemd, since a
#     container has no way to shut down or update the machine it's running on
set -e

REPO_URL="https://github.com/AstroLabs-UK/SquadronDashboard.git"
REPO_DIRNAME="SquadronDashboard"
DASHBOARD_URL="http://localhost:3000"

echo "== Squadron Dashboard - Docker install =="

# 1. Install Docker if it's missing
if ! command -v docker >/dev/null 2>&1; then
  echo "-> Docker not found, installing (this is the official Docker install script)..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$(whoami)"
  echo "-> Docker installed."
else
  echo "-> Docker already installed"
fi

# 2. Work out whether we're already inside the repo, or need to clone it
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || pwd)"
if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
  DIR="$SCRIPT_DIR"
else
  echo "-> Not running from inside the repo - fetching it..."
  if ! command -v git >/dev/null 2>&1; then
    sudo apt-get update -y
    sudo apt-get install -y git
  fi
  if [ -d "$REPO_DIRNAME" ]; then
    (cd "$REPO_DIRNAME" && git pull)
  else
    git clone "$REPO_URL" "$REPO_DIRNAME"
  fi
  DIR="$(cd "$REPO_DIRNAME" && pwd)"
fi
cd "$DIR"

# 3. Make sure the data files exist as real files before Docker touches them -
#    a bind-mount of a path that doesn't exist yet gets created as a directory,
#    not a file, which would break the app
touch data.backup.json
[ -s data.backup.json ] || echo '{}' > data.backup.json
[ -f data.json ] || echo '{}' > data.json

# 4. Build and start the dashboard container
echo "-> Building and starting the dashboard container..."
sudo docker compose up -d --build

# 5. Auto shutdown - 2h45m after every boot, handled entirely on the host so
#    the container needs no special privileges
echo "-> Setting up auto-shutdown (2h45m after boot)..."
sudo tee /etc/systemd/system/squadron-dashboard-shutdown.service > /dev/null <<'EOF'
[Unit]
Description=Squadron Dashboard auto shutdown (2h45m after boot)

[Service]
Type=simple
ExecStart=/bin/bash -c 'sleep 9900 && /sbin/shutdown -h now'

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now squadron-dashboard-shutdown.service

# 6. Auto update - checks this repo every 30 minutes, rebuilds the container
#    if there's a new commit
echo "-> Setting up auto-update (checks every 30 minutes)..."
cat > "$DIR/docker-update.sh" <<'EOF'
#!/usr/bin/env bash
cd "$(dirname "$0")"
git fetch --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse @{u})
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "Update found - pulling and rebuilding..."
  git pull --quiet
  sudo docker compose up -d --build
fi
EOF
chmod +x "$DIR/docker-update.sh"

sudo tee /etc/systemd/system/squadron-dashboard-update.service > /dev/null <<EOF
[Unit]
Description=Squadron Dashboard auto update check

[Service]
Type=oneshot
WorkingDirectory=$DIR
ExecStart=$DIR/docker-update.sh
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
sudo systemctl daemon-reload
sudo systemctl enable --now squadron-dashboard-update.timer

# 7. Chromium kiosk - installed if missing, launched on boot pointed at the dashboard
if ! command -v chromium-browser >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
  echo "-> Installing Chromium..."
  sudo apt-get update -y
  sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium
fi
CHROMIUM_BIN="$(command -v chromium-browser || command -v chromium)"

KIOSK_LAUNCHER="$HOME/squadron-dashboard-kiosk.sh"
cat > "$KIOSK_LAUNCHER" <<EOF
#!/usr/bin/env bash
# Wait for the dashboard container to actually respond before opening the browser
for i in \$(seq 1 60); do
  curl -sf $DASHBOARD_URL > /dev/null && break
  sleep 2
done
$CHROMIUM_BIN --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required $DASHBOARD_URL
EOF
chmod +x "$KIOSK_LAUNCHER"

echo "-> Configuring Chromium to launch automatically on boot..."
AUTOSTART_ADDED=0

# Raspberry Pi OS Bullseye and earlier (X11 / LXDE)
if [ -d "$HOME/.config/lxsession/LXDE-pi" ] || command -v startlxde-pi >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/lxsession/LXDE-pi"
  AUTOSTART_FILE="$HOME/.config/lxsession/LXDE-pi/autostart"
  touch "$AUTOSTART_FILE"
  grep -qxF "@$KIOSK_LAUNCHER" "$AUTOSTART_FILE" || echo "@$KIOSK_LAUNCHER" >> "$AUTOSTART_FILE"
  AUTOSTART_ADDED=1
fi

# Raspberry Pi OS Bookworm and later (Wayland / labwc)
if [ -d "$HOME/.config/labwc" ] || [ -f "$HOME/.config/wayfire.ini" ] || command -v labwc >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/labwc"
  AUTOSTART_FILE="$HOME/.config/labwc/autostart"
  touch "$AUTOSTART_FILE"
  grep -qxF "$KIOSK_LAUNCHER &" "$AUTOSTART_FILE" || echo "$KIOSK_LAUNCHER &" >> "$AUTOSTART_FILE"
  AUTOSTART_ADDED=1
fi

if [ "$AUTOSTART_ADDED" -eq 0 ]; then
  echo "-> Could not detect LXDE or labwc automatically."
  echo "   Add this line to your desktop environment's autostart file yourself:"
  echo "   $KIOSK_LAUNCHER"
fi

echo
echo "== Setup complete =="
echo "  Dashboard: $DASHBOARD_URL"
echo "  Edit:      $DASHBOARD_URL/edit    (replace localhost with this Pi's IP from another device)"
echo "  Status:    $DASHBOARD_URL/status"
echo
echo "Reboot now to see it launch full-screen automatically:"
echo "  sudo reboot"
echo
echo "Useful commands:"
echo "  sudo docker compose logs -f          # view the dashboard's logs"
echo "  sudo docker compose restart          # restart the dashboard container"
echo "  sudo docker compose up -d --build    # manually rebuild/update"
