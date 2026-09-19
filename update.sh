#!/usr/bin/env bash
# Squadron Dashboard - update from GitHub, keeping this device's own settings.
#
#   sqndash --update         update if there's a new version (the easy way, from anywhere)
#   sqndash --force-update   re-download and restart even if already up to date
#   bash update.sh [--force] (same things, from inside the folder)
#
# Also runs automatically shortly after every boot and every 30 minutes after that, and
# in force mode whenever "Force update" is pressed on the /edit page.
#
# Settings saved from /edit live in the data/ folder, which is git-ignored, so
# updating the code never touches them. This script also keeps a safety copy while
# it updates and checks the settings are still there afterwards.
set -u
DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
cd "$DIR" || exit 1
OWNER="$(stat -c %U "$DIR")"
if [ "$(id -u)" -eq 0 ]; then SUDO=""; SUDOQ=""; else SUDO="sudo"; SUDOQ="sudo -n"; fi
REQUEST_FILE="$DIR/data/update-request.json"
STATUS_FILE="$DIR/data/update-status.json"
FORCE=0

# Result of the latest run, read by the /edit page (Force update button).
# Messages are fixed strings, so they're safe to put in JSON as-is.
write_status() {  # state message
  [ -d "$DIR/data" ] || return 0
  local tmp="$DIR/data/.update-status.$$"
  { printf '{"state":"%s","message":"%s","time":%s}\n' "$1" "$2" "$(date +%s)" > "$tmp" \
      && mv -f "$tmp" "$STATUS_FILE"; } 2>/dev/null || rm -f "$tmp" 2>/dev/null
  return 0
}

# Makes the `sqndash` command available everywhere on the Pi
install_command() {
  local target=/usr/local/bin/sqndash
  local content="#!/usr/bin/env bash
exec bash \"$DIR/sqndash.sh\" \"\$@\""
  if [ "$(cat "$target" 2>/dev/null)" = "$content" ]; then return 0; fi
  { printf '%s\n' "$content" | $SUDOQ tee "$target" >/dev/null && $SUDOQ chmod +x "$target"; } 2>/dev/null || true
}

# Makes sure the Pi is watching for "Force update" requests from the /edit page
# (a systemd path unit that runs the update service when data/update-request.json appears)
ensure_watcher() {
  command -v systemctl >/dev/null 2>&1 || return 0
  local svc=/etc/systemd/system/squadron-dashboard-update.service
  local unit=/etc/systemd/system/squadron-dashboard-update.path
  [ -f "$svc" ] || return 0
  if [ -f "$unit" ] && grep -q "PathExists=$REQUEST_FILE" "$unit" 2>/dev/null; then return 0; fi
  {
    printf '[Unit]\nDescription=Squadron Dashboard - update now when requested from /edit\n\n[Path]\nPathExists=%s\n\n[Install]\nWantedBy=multi-user.target\n' "$REQUEST_FILE" | $SUDOQ tee "$unit" >/dev/null \
      && $SUDOQ systemctl daemon-reload && $SUDOQ systemctl enable --now squadron-dashboard-update.path
  } >/dev/null 2>&1 || true
}

# Step 1 - download the new code. Runs as the folder's owner (never as root), so git
# doesn't complain about ownership and files/folders keep the right owner.
# Exit code: 0 = already up to date, 10 = updated, 11 = forced re-apply (no new version),
#            anything else = problem.
sync_code() {
  # Older versions kept settings in data.json next to server.js. Move them into data/
  # (copy only - never delete - and never overwrite anything already in data/).
  mkdir -p data
  for f in data.json data.backup.json; do
    if [ -f "$f" ] && [ ! -f "data/$f" ]; then cp -p "$f" "data/$f"; fi
  done
  [ -f data/data.json ] || cp data.example.json data/data.json
  [ -f data/data.backup.json ] || cp data/data.json data/data.backup.json

  echo "[update] checking GitHub..."
  # Ensure we can use the existing local Git installation (no reinstall needed).
  if ! command -v git >/dev/null 2>&1; then
    echo "[update] git is not installed - cannot update"
    return 2
  fi
  # Avoid "dubious ownership" / safe.directory issues on the Pi when the folder
  # is owned by a different user than the one running the update.
  git config --global --add safe.directory "$DIR" 2>/dev/null || true
  # Reduce false "local changes" from executable-bit differences across installs
  git config core.filemode false 2>/dev/null || true

  if ! git fetch --quiet origin 2>/dev/null && ! git fetch --quiet 2>/dev/null; then
    echo "[update] can't reach GitHub - skipping this check"
    return 1
  fi

  local LOCAL REMOTE RC=10
  LOCAL="$(git rev-parse HEAD 2>/dev/null)" || LOCAL=""
  REMOTE="$(git rev-parse '@{u}' 2>/dev/null || git rev-parse origin/main 2>/dev/null || git rev-parse origin/master 2>/dev/null || true)"
  if [ -z "$REMOTE" ]; then
    echo "[update] could not determine remote tip - is the remote configured?"
    return 3
  fi
  if [ "$LOCAL" = "$REMOTE" ]; then
    if [ "$FORCE" -ne 1 ]; then
      echo "[update] already on the latest version ($(git rev-parse --short HEAD))"
      return 0
    fi
    echo "[update] already on the latest version - forcing a clean re-apply anyway"
    RC=11
  else
    echo "[update] new version found - downloading..."
  fi

  local KEEP
  KEEP="$(mktemp -d)"
  cp -a data "$KEEP/data"           # safety copy of the settings

  # Force the working tree to match GitHub exactly. Do not stop for a dirty tree;
  # any local edits to tracked files are discarded (settings live in data/ and are kept).
  git reset --hard --quiet "$REMOTE" 2>/dev/null || git reset --hard --quiet '@{u}'
  # Remove untracked files/dirs that are not settings (data/ is gitignored and preserved)
  git clean -fd --quiet 2>/dev/null || true

  # Belt and braces: if anything about data/ went missing, put the safety copy back
  mkdir -p data
  for f in data.json data.backup.json; do
    [ -f "data/$f" ] || { [ -f "$KEEP/data/$f" ] && cp -p "$KEEP/data/$f" "data/$f"; }
  done
  rm -rf "$KEEP"
  echo "[update] downloaded $(git rev-parse --short HEAD)"
  return $RC
}

# Step 2 - restart the app so the new code is running (needs root)
restart_app() {
  echo "[update] restarting the dashboard..."
  if command -v docker >/dev/null 2>&1 && $SUDO docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'squadron-dashboard'; then
    $SUDO docker compose up -d --build
  else
    npm install --omit=dev --quiet
    $SUDO systemctl restart squadron-dashboard.service
  fi
}

case "${1:-}" in
  --sync)    [ "${2:-}" = "force" ] && FORCE=1; sync_code; exit $? ;;
  --restart) restart_app; rc=$?; [ $rc -eq 0 ] && echo "[update] done - the screen reloads itself within about 10 seconds"; exit $rc ;;
  --force)   FORCE=1 ;;
esac

# A "Force update" request from the /edit page (file dropped into data/)
if [ -f "$REQUEST_FILE" ]; then FORCE=1; rm -f "$REQUEST_FILE"; fi

install_command
ensure_watcher
write_status running "Checking GitHub..."

owner_run() { if [ "$(id -u)" -eq 0 ] && [ "$OWNER" != "root" ]; then runuser -u "$OWNER" -- "$@"; else "$@"; fi; }
if [ "$FORCE" -eq 1 ]; then owner_run bash "$DIR/update.sh" --sync force; else owner_run bash "$DIR/update.sh" --sync; fi
rc=$?
HASH="$(owner_run git rev-parse --short HEAD 2>/dev/null)"

case "$rc" in
  0)
    write_status done "Already on the latest version ($HASH) - nothing to update"
    exit 0 ;;
  10|11)
    write_status running "Downloaded $HASH - restarting the dashboard..."
    if restart_app; then
      echo "[update] done - the screen reloads itself within about 10 seconds"
      if [ "$rc" -eq 10 ]; then write_status done "Updated to $HASH and restarted"
      else write_status done "Already on the latest version ($HASH) - re-applied it and restarted"; fi
      exit 0
    fi
    write_status error "Downloaded $HASH but restarting failed - reboot the Pi or run sqndash --restart"
    exit 1 ;;
  1)
    write_status error "Couldn't reach GitHub - check the Pi's internet connection"
    exit 1 ;;
  *)
    write_status error "The update failed (code $rc) - run sqndash --force-update on the Pi to see why"
    exit "$rc" ;;
esac
