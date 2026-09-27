#!/usr/bin/env bash
# Squadron Dashboard CLI — installed as /usr/local/bin/sqndash so it works from any folder.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$SCRIPT_DIR"
# If invoked via /usr/local/bin/sqndash wrapper, BASH_SOURCE may still be this file
# when exec'd; DIR is the app root (same folder as this script after install).

usage() {
  cat <<'EOF2'
Squadron Dashboard — command line

  sqndash                 show this help
  sqndash --help          show this help
  sqndash --start         start the dashboard service
  sqndash --stop          stop the dashboard service
  sqndash --restart       restart the dashboard
  sqndash --check         show local / remote version info
  sqndash --update        check for updates and apply if available
  sqndash --force-update  download latest allowed release onto disk
  sqndash --set-pin [PIN] set the PIN that protects /edit (4+ characters)
  sqndash --clear-pin     remove the PIN (anyone on the LAN can then edit)
  sqndash --channel [name]
                          show or set update channel:
                            stable = newest tagged release (default)
                            update = tip of the Update branch (testing)

Settings from /edit are never wiped by an update.
EOF2
}

set_pin() {
  local pin="${1:-}"
  if [ -z "$pin" ]; then
    read -r -s -p "New editor PIN (4+ characters): " pin; echo
    local again
    read -r -s -p "Type it again: " again; echo
    [ "$pin" = "$again" ] || { echo "The two entries don't match - nothing changed."; exit 1; }
  fi
  if [ "${#pin}" -lt 4 ]; then echo "The PIN must be at least 4 characters - nothing changed."; exit 1; fi
  case "$pin" in *$'\n'*|*$'\r'*) echo "The PIN can't contain line breaks."; exit 1;; esac
  mkdir -p "$DIR/data"
  ( umask 077; printf '%s\n' "$pin" > "$DIR/data/edit-pin.tmp" && mv -f "$DIR/data/edit-pin.tmp" "$DIR/data/edit-pin" )
  echo "Editor PIN saved. It applies straight away - no restart needed."
  echo "Open /edit and enter the PIN on the unlock screen."
}

case "${1:-}" in
  ""|--help|-h) usage ;;
  --start)      exec bash "$DIR/update.sh" --start ;;
  --stop)       exec bash "$DIR/update.sh" --stop ;;
  --check|--version|-v) exec bash "$DIR/update.sh" --check ;;
  --update|-u)  exec bash "$DIR/update.sh" ;;
  --force-update|-f) exec bash "$DIR/update.sh" --force ;;
  --restart|-r) exec bash "$DIR/update.sh" --restart ;;
  --set-pin)    set_pin "${2:-}" ;;
  --clear-pin)
    rm -f "$DIR/data/edit-pin"
    echo "Editor PIN removed. (An EDIT_PIN environment variable, if you set one, still applies.)" ;;
  --channel)
    if [ -z "${2:-}" ]; then
      echo "Update channel: $(tr -d '[:space:]' < "$DIR/data/update-channel" 2>/dev/null || echo stable)"
    else
      case "$2" in
        stable|update|release|main)
          mkdir -p "$DIR/data"
          case "$2" in release) ch=stable ;; main) ch=update ;; *) ch="$2" ;; esac
          printf '%s\n' "$ch" > "$DIR/data/update-channel"
          echo "Update channel set to: $ch" ;;
        *) echo "Channel must be 'stable' or 'update'."; exit 1 ;;
      esac
    fi ;;
  *) echo "Unknown option: $1"; echo; usage; exit 1 ;;
esac
