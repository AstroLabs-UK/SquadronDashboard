#!/usr/bin/env bash
# Squadron Dashboard - update from GitHub, keeping this device's own settings.
#
# Runs on every boot (shortly after the network comes up) and every 30 minutes
# after that. Safe to run by hand any time:  bash update.sh
#
# Whatever is on GitHub replaces the code, but data.json / data.backup.json (the
# settings saved from /edit) are set aside first and put back afterwards, so an
# update can never overwrite or conflict with them.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR" || exit 1

if ! git fetch --quiet 2>/dev/null; then
  echo "[update] can't reach GitHub - skipping this check"
  exit 0
fi

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse '@{u}')"
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "[update] already up to date"
  exit 0
fi

echo "[update] update found - applying..."
KEEP="$(mktemp -d)"
for f in data.json data.backup.json; do
  [ -f "$f" ] && cp -p "$f" "$KEEP/$f"
done

git reset --hard --quiet '@{u}'

for f in data.json data.backup.json; do
  [ -f "$KEEP/$f" ] && cp -p "$KEEP/$f" "$f"
done
rm -rf "$KEEP"

# First-run / fresh clone: make sure both settings files exist as real files
# (Docker would otherwise create them as folders when bind-mounting).
[ -f data.json ] || cp data.example.json data.json
[ -f data.backup.json ] || cp data.json data.backup.json

# Restart the app so the new code is running
if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'squadron-dashboard'; then
  docker compose up -d --build
else
  npm install --omit=dev --quiet
  systemctl restart squadron-dashboard.service 2>/dev/null || sudo systemctl restart squadron-dashboard.service
fi
echo "[update] done"
