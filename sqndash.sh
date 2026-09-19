#!/usr/bin/env bash
# The `sqndash` command. Installed to /usr/local/bin by the installer and by update.sh.
#
#   sqndash --check / --version   compare local code to GitHub
#   sqndash --update              update if newer on GitHub, then restart
#   sqndash --force-update        re-download even if up to date, then restart
#   sqndash --restart             restart the dashboard
#   sqndash --help
DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

usage() {
  cat <<'EOF'
Squadron Dashboard

  sqndash --check            compare local version to GitHub (also: --version)
  sqndash --update           update if newer on GitHub, then restart
  sqndash --force-update     re-download even if already up to date, then restart
  sqndash --restart          restart the dashboard
  sqndash --help             show this help

Your settings (from /edit) are never changed by an update.
EOF
}

check_version() {
  cd "$DIR" || exit 1
  if ! command -v git >/dev/null 2>&1; then
    echo "git is not installed"
    exit 2
  fi
  if [ ! -d "$DIR/.git" ]; then
    echo "Not a git repository: $DIR"
    exit 3
  fi
  echo "Fetching from GitHub..."
  git fetch origin --quiet 2>/dev/null || git fetch --quiet 2>/dev/null || {
    echo "Could not reach GitHub"
    exit 1
  }
  LOCAL="$(git rev-parse --short HEAD 2>/dev/null)"
  LOCAL_FULL="$(git rev-parse HEAD 2>/dev/null)"
  LOCAL_MSG="$(git log -1 --pretty=%s 2>/dev/null)"
  REMOTE_REF=""
  for ref in origin/main origin/master origin/HEAD; do
    if git rev-parse --verify "$ref" >/dev/null 2>&1; then
      REMOTE_REF="$ref"
      break
    fi
  done
  if [ -z "$REMOTE_REF" ]; then
    echo "Local:  $LOCAL  $LOCAL_MSG"
    echo "Remote: (could not resolve origin/main or origin/master)"
    exit 3
  fi
  REMOTE="$(git rev-parse --short "$REMOTE_REF" 2>/dev/null)"
  REMOTE_FULL="$(git rev-parse "$REMOTE_REF" 2>/dev/null)"
  REMOTE_MSG="$(git log -1 --pretty=%s "$REMOTE_REF" 2>/dev/null)"
  BEHIND="$(git rev-list --count HEAD.."$REMOTE_REF" 2>/dev/null || echo 0)"
  AHEAD="$(git rev-list --count "$REMOTE_REF"..HEAD 2>/dev/null || echo 0)"
  echo "Local:  $LOCAL  $LOCAL_MSG"
  echo "GitHub: $REMOTE  $REMOTE_MSG  ($REMOTE_REF)"
  if [ "$LOCAL_FULL" = "$REMOTE_FULL" ]; then
    echo "Status: up to date"
    exit 0
  fi
  echo "Status: local is behind by $BEHIND commit(s), ahead by $AHEAD"
  exit 10
}

case "${1:-}" in
  --check|--version|-v) check_version ;;
  --update|-u)  exec bash "$DIR/update.sh" ;;
  --force-update|-f) exec bash "$DIR/update.sh" --force ;;
  --restart|-r) exec bash "$DIR/update.sh" --restart ;;
  --help|-h|"") usage ;;
  *) echo "Unknown option: $1"; echo; usage; exit 1 ;;
esac
