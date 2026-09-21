#!/usr/bin/env bash
# Squadron Dashboard - update from GitHub, keeping this device's own settings.
#
#   sqndash --update         update if there's a new version (the easy way, from anywhere)
#   sqndash --force-update   re-download and restart even if already up to date
#   bash update.sh [--force] (same things, from inside the folder)
#   bash update.sh --check   compare this copy with the update target, change nothing
#
# Also runs automatically shortly after every boot and every 30 minutes after that, and
# in force mode whenever "Force update" is pressed on the /edit page.
#
# WHICH version? By default the newest release tag on GitHub (v1.5.0, v1.6.0 ...), not the
# tip of main, so unfinished work can't reach a room screen. `sqndash --channel main` makes
# a test device follow main instead. A device that is already ahead of the target is left alone.
#
# SAFETY NET: after the restart the script waits for /healthz to answer. If the new version
# doesn't come up it goes back to the previous version, restarts that, and remembers the
# bad release (data/skip-release.json) so it isn't retried every 30 minutes.
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
LAST_GOOD_FILE="$DIR/data/last-good-commit"
SKIP_FILE="$DIR/data/skip-release.json"
HEALTH_URL="http://127.0.0.1:${PORT:-3000}/healthz"
FORCE=0

owner_run() { if [ "$(id -u)" -eq 0 ] && [ "$OWNER" != "root" ]; then runuser -u "$OWNER" -- "$@"; else "$@"; fi; }

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

# Work out the version this device should be running. Sets:
#   CHANNEL, TARGET_REF, TARGET_LABEL, TARGET_SHA, TARGET_SHORT, TARGET_MSG
resolve_target() {
  CHANNEL="${UPDATE_CHANNEL:-}"
  if [ -z "$CHANNEL" ] && [ -f data/update-channel ]; then CHANNEL="$(tr -d '[:space:]' < data/update-channel)"; fi
  CHANNEL="$(printf '%s' "$CHANNEL" | tr 'A-Z' 'a-z')"
  [ "$CHANNEL" = "main" ] || CHANNEL="release"
  TARGET_REF=""; TARGET_LABEL=""
  if [ "$CHANNEL" = "release" ]; then
    local TAG
    TAG="$(git tag -l 'v*' 2>/dev/null | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -1)"
    if [ -n "$TAG" ]; then TARGET_REF="$TAG"; TARGET_LABEL="release $TAG"; fi
  fi
  if [ -z "$TARGET_REF" ]; then
    local r
    for r in origin/main origin/master origin/HEAD; do
      if git rev-parse --verify --quiet "$r^{commit}" >/dev/null 2>&1; then TARGET_REF="$r"; break; fi
    done
    [ -n "$TARGET_REF" ] || return 1
    TARGET_LABEL="$TARGET_REF"
    [ "$CHANNEL" = "release" ] && TARGET_LABEL="$TARGET_REF (no release tags yet)"
  fi
  TARGET_SHA="$(git rev-parse "$TARGET_REF^{commit}" 2>/dev/null)" || return 1
  TARGET_SHORT="$(git rev-parse --short "$TARGET_SHA" 2>/dev/null)"
  TARGET_MSG="$(git log -1 --pretty=%s "$TARGET_SHA" 2>/dev/null)"
  return 0
}

fetch_remote() {
  git fetch --quiet --tags --force --prune origin 2>/dev/null || git fetch --quiet --tags --force 2>/dev/null
}

# `update.sh --check` - compare, change nothing. Exit: 0 up to date, 10 behind, 1 no GitHub, 3 other problem
check_only() {
  command -v git >/dev/null 2>&1 || { echo "git is not installed"; return 2; }
  [ -d "$DIR/.git" ] || { echo "Not a git repository: $DIR"; return 3; }
  git config --global --add safe.directory "$DIR" 2>/dev/null || true
  echo "Fetching from GitHub..."
  fetch_remote || { echo "Could not reach GitHub"; return 1; }
  local LOCAL
  LOCAL="$(git rev-parse HEAD 2>/dev/null)"
  echo "Local:   $(git rev-parse --short HEAD 2>/dev/null)  $(git log -1 --pretty=%s 2>/dev/null)"
  if ! resolve_target; then echo "Target:  (no release tag or origin/main found)"; return 3; fi
  echo "Target:  $TARGET_SHORT  $TARGET_MSG  ($TARGET_LABEL, $CHANNEL channel)"
  if [ "$LOCAL" = "$TARGET_SHA" ]; then echo "Status: up to date"; return 0; fi
  if git merge-base --is-ancestor "$TARGET_SHA" "$LOCAL" 2>/dev/null; then
    echo "Status: this copy is newer than the target - nothing to update"; return 0
  fi
  echo "Status: behind by $(git rev-list --count "HEAD..$TARGET_SHA" 2>/dev/null || echo '?') commit(s)"
  return 10
}

# Step 1 - download the new code. Runs as the folder's owner (never as root), so git
# doesn't complain about ownership and files/folders keep the right owner.
# Exit code: 0 = already up to date, 10 = updated, 11 = forced re-apply (no new version),
#            12 = target release failed its safety check earlier (skipped),
#            anything else = problem.
sync_code() {
  # Older versions kept settings in data.json next to server.js. Move them into data/
  # (copy only - never delete - and never overwrite anything already in data/).
  mkdir -p data
  for f in data.json data.backup.json; do
    if [ -f "$f" ] && [ ! -f "data/$f" ]; then cp -p "$f" "data/$f"; fi
  done
  # Settings safety copy lives OUTSIDE the app folder, so even a wiped data/ can be recovered
  SNAP_BASE="$(dirname "$DIR")"; [ "$SNAP_BASE" = "/" ] && SNAP_BASE="$HOME"
  SNAP="${DATA_BACKUP_DIR:-$SNAP_BASE/.squadron-dashboard-backup}"
  if [ ! -f data/data.json ] && [ -f "$SNAP/data.json" ]; then
    echo "[update] settings were missing - restoring them from $SNAP"
    cp -a "$SNAP/." data/
  fi
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

  if ! fetch_remote; then
    echo "[update] can't reach GitHub - skipping this check"
    return 1
  fi

  local LOCAL RC=10
  LOCAL="$(git rev-parse HEAD 2>/dev/null)" || LOCAL=""
  if ! resolve_target; then
    echo "[update] could not find a release tag or origin/main - is the remote configured?"
    return 3
  fi
  echo "[update] target: $TARGET_LABEL ($TARGET_SHORT) on the $CHANNEL channel"

  if [ "$LOCAL" = "$TARGET_SHA" ]; then
    if [ "$FORCE" -ne 1 ]; then
      echo "[update] already on the latest version ($(git rev-parse --short HEAD))"
      return 0
    fi
    echo "[update] already on the latest version - forcing a clean re-apply anyway"
    RC=11
  elif [ "$FORCE" -ne 1 ] && git merge-base --is-ancestor "$TARGET_SHA" "$LOCAL" 2>/dev/null; then
    echo "[update] this copy ($(git rev-parse --short HEAD)) is newer than $TARGET_LABEL - not downgrading"
    return 0
  elif [ "$FORCE" -ne 1 ] && [ "$(sed -n 's/.*"sha" *: *"\([0-9a-f]*\)".*/\1/p' "$SKIP_FILE" 2>/dev/null | head -1)" = "$TARGET_SHA" ]; then
    echo "[update] $TARGET_LABEL failed its safety check earlier - skipping it (sqndash --force-update to try again)"
    return 12
  else
    echo "[update] new version found - downloading..."
  fi

  # Remember where we were, so a bad update can be rolled back
  printf '%s\n' "$LOCAL" > "$LAST_GOOD_FILE" 2>/dev/null || true

  local KEEP
  KEEP="$(mktemp -d)"
  cp -a data "$KEEP/data"           # safety copy of the settings
  if [ -f data/data.json ]; then    # ...and a lasting one outside the app folder
    mkdir -p "$SNAP" 2>/dev/null && chmod 700 "$SNAP" 2>/dev/null; cp -a data/. "$SNAP/" 2>/dev/null || true
  fi

  # Force the working tree to match the target exactly. Do not stop for a dirty tree;
  # any local edits to tracked files are discarded (settings live in data/ and are kept).
  git reset --hard --quiet "$TARGET_SHA" 2>/dev/null || { rm -rf "$KEEP"; echo "[update] git reset failed"; return 4; }
  # Remove untracked files/dirs that are not settings (data/ is gitignored and preserved)
  # (-e keeps settings and installer-made files even if this release's .gitignore is missing)
  git clean -fd --quiet -e /data -e /data.json -e /data.backup.json -e /node_modules \
    -e /shutdown-timer.sh -e /npm-update.sh -e /docker-update.sh 2>/dev/null || true

  # Put the settings back exactly as they were - overwriting anything the release put there
  # (covers a release that is missing .gitignore, or that accidentally tracks data/)
  mkdir -p data
  cp -a "$KEEP/data/." data/
  rm -rf "$KEEP"
  echo "[update] downloaded $(git rev-parse --short HEAD)"
  return $RC
}

uses_docker() {
  command -v docker >/dev/null 2>&1 && $SUDO docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'squadron-dashboard'
}

# systemd installs only: the dashboard must never be left stopped.
#  - Restart=always: if the app ever exits (even "cleanly", as an in-app update used to), systemd starts it again.
#  - If it is stopped right now (e.g. a previous update left it down), start it.
ensure_app_running() {
  command -v systemctl >/dev/null 2>&1 || return 0
  local unit=/etc/systemd/system/squadron-dashboard.service
  [ -f "$unit" ] || return 0
  uses_docker && return 0
  if grep -q '^Restart=on-failure' "$unit" 2>/dev/null; then
    { $SUDOQ sed -i 's/^Restart=on-failure/Restart=always/' "$unit" && $SUDOQ systemctl daemon-reload; } >/dev/null 2>&1 || true
  fi
  if ! systemctl is-active --quiet squadron-dashboard.service 2>/dev/null; then
    echo "[update] the dashboard was not running - starting it"
    $SUDO systemctl start squadron-dashboard.service || true
  fi
}

# Step 2 - restart the app so the new code is running (needs root)
restart_app() {
  echo "[update] restarting the dashboard..."
  if uses_docker; then
    $SUDO docker compose up -d --build
  else
    npm install --omit=dev --quiet
    $SUDO systemctl restart squadron-dashboard.service
    # `restart` starts it even if it was stopped, but make sure - a stopped dashboard is the worst outcome
    sleep 2
    if command -v systemctl >/dev/null 2>&1 && ! systemctl is-active --quiet squadron-dashboard.service 2>/dev/null; then
      $SUDO systemctl start squadron-dashboard.service || true
    fi
  fi
}

# Start the dashboard if it is not already running (systemd service, Docker, or node).
start_app() {
  echo "[start] starting the dashboard..."
  if uses_docker; then
    $SUDO docker compose up -d --build
    echo "[start] Docker container started"
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1 && [ -f /etc/systemd/system/squadron-dashboard.service ]; then
    if systemctl is-active --quiet squadron-dashboard.service 2>/dev/null; then
      echo "[start] already running (systemd)"
      return 0
    fi
    $SUDO systemctl start squadron-dashboard.service
    sleep 1
    if systemctl is-active --quiet squadron-dashboard.service 2>/dev/null; then
      echo "[start] done - squadron-dashboard.service is active"
      return 0
    fi
    echo "[start] systemd start failed - falling back to node"
  fi
  # Bare-metal fallback: run node in the background if nothing is listening yet
  if command -v node >/dev/null 2>&1; then
    mkdir -p "$DIR/data"
    npm install --omit=dev --quiet 2>/dev/null || true
    nohup node "$DIR/server.js" >>"$DIR/data/sqndash.log" 2>&1 &
    echo "[start] started node in the background (http://localhost:3000) - log: data/sqndash.log"
    return 0
  fi
  echo "[start] could not start - install the service with install.sh, or run: npm start"
  return 1
}

# Step 3 - wait for the restarted app to answer /healthz (up to ~90 s).
# If this Pi has neither curl nor wget the check is skipped rather than failing every update.
wait_healthy() {
  local probe=""
  if command -v curl >/dev/null 2>&1; then probe="curl -fsS -m 3 -o /dev/null"
  elif command -v wget >/dev/null 2>&1; then probe="wget -q -T 3 -O /dev/null"
  else echo "[update] no curl/wget - skipping the health check"; return 0; fi
  local waited=0
  while [ "$waited" -lt 90 ]; do
    if $probe "$HEALTH_URL" 2>/dev/null; then return 0; fi
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

# The new version didn't come up: go back to the last good one and remember the bad release.
rollback_update() {
  local BAD PREV
  BAD="$(owner_run git rev-parse HEAD 2>/dev/null)"
  PREV="$(cat "$LAST_GOOD_FILE" 2>/dev/null)"
  [ -n "$PREV" ] || { echo "[update] no previous version recorded - can't roll back"; return 1; }
  echo "[update] the new version did not start - rolling back to ${PREV:0:7}"
  write_status running "New version did not start - rolling back..."
  owner_run git reset --hard --quiet "$PREV" && owner_run git clean -fd --quiet
  mkdir -p "$DIR/data" 2>/dev/null
  printf '{"sha":"%s","reason":"failed the post-update health check","time":%s}\n' "$BAD" "$(date +%s)" > "$SKIP_FILE" 2>/dev/null || true
  restart_app && wait_healthy
}

case "${1:-}" in
  --check)   check_only; exit $? ;;
  --sync)    [ "${2:-}" = "force" ] && FORCE=1; sync_code; exit $? ;;
  --restart) restart_app; rc=$?; [ $rc -eq 0 ] && echo "[update] done - the screen reloads itself within about 10 seconds"; exit $rc ;;
  --start) start_app; exit $? ;;
  --force)   FORCE=1 ;;
esac

# A "Force update" request from the /edit page (file dropped into data/)
if [ -f "$REQUEST_FILE" ]; then FORCE=1; rm -f "$REQUEST_FILE"; fi

install_command
ensure_watcher
ensure_app_running
write_status running "Checking GitHub..."

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
      if wait_healthy; then
        echo "[update] done - the screen reloads itself within about 10 seconds"
        if [ "$rc" -eq 10 ]; then write_status done "Updated to $HASH and restarted"
        else write_status done "Already on the latest version ($HASH) - re-applied it and restarted"; fi
        exit 0
      fi
      if rollback_update; then
        write_status error "Update to $HASH did not start, so it was rolled back to the previous version"
      else
        write_status error "Update to $HASH did not start and the rollback failed - run sqndash --restart or reboot the Pi"
      fi
      exit 1
    fi
    write_status error "Downloaded $HASH but restarting failed - reboot the Pi or run sqndash --restart"
    exit 1 ;;
  12)
    write_status error "The newest release failed its safety check on an earlier update, so it was skipped ($HASH is still running)"
    exit 0 ;;
  1)
    write_status error "Couldn't reach GitHub - check the Pi's internet connection"
    exit 1 ;;
  *)
    write_status error "The update failed (code $rc) - run sqndash --force-update on the Pi to see why"
    exit "$rc" ;;
esac
