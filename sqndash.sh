#!/usr/bin/env bash
# The `sqndash` command. Installed to /usr/local/bin by the installer and by update.sh,
# so it works from any folder:
#
#   sqndash --update         update to the latest version on GitHub and restart the dashboard
#   sqndash --force-update   re-download and restart even if already up to date
#   sqndash --restart        restart the dashboard
#   sqndash --help           show this list
DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

usage() {
  cat <<'EOF'
Squadron Dashboard

  sqndash --update         update to the latest version on GitHub and restart the dashboard
  sqndash --force-update   re-download and restart even if already up to date
  sqndash --restart        restart the dashboard
  sqndash --help           show this help

Your settings (from /edit) are never changed by an update.
EOF
}

case "${1:-}" in
  --update|-u)  exec bash "$DIR/update.sh" ;;
  --force-update|-f) exec bash "$DIR/update.sh" --force ;;
  --restart|-r) exec bash "$DIR/update.sh" --restart ;;
  --help|-h|"") usage ;;
  *) echo "Unknown option: $1"; echo; usage; exit 1 ;;
esac
