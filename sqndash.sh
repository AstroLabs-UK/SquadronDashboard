#!/usr/bin/env bash
# The `sqndash` command. Installed to /usr/local/bin by the installer and by update.sh.
#
#   sqndash                   start the dashboard service
#   sqndash --start           same as above
#   sqndash --check / --version   compare local code to the update target (newest release)
#   sqndash --update              update if there's a newer release, then restart
#   sqndash --force-update        re-download even if up to date, then restart
#   sqndash --restart             restart the dashboard
#   sqndash --set-pin [PIN]       set the PIN that protects /edit (asks if you don't give one)
#   sqndash --clear-pin           remove the PIN (leaves /edit open to anyone on the network)
#   sqndash --channel [stable|update]   show or change which versions this device follows
#   sqndash --help
DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

usage() {
  cat <<'EOF2'
Squadron Dashboard

  sqndash                  start the dashboard service
  sqndash --start          same as above
  sqndash --stop           stop all running dashboard instances
  sqndash --check          compare local version to the update target (also: --version)
  sqndash --update         update if there's a newer release, then restart
  sqndash --force-update   re-download even if already up to date, then restart
  sqndash --restart        restart the dashboard
  sqndash --set-pin [PIN]  set the PIN that protects the /edit page (4+ characters)
  sqndash --clear-pin      remove the PIN (anyone on the network can then edit)
  sqndash --channel [name] show, or set, the update channel:
                             stable = newest tagged release (default, safest)
                             update = tip of the Update branch (for a test device)
  sqndash --help           show this help

Your settings (from /edit) are never changed by an update.
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
  ""|--start)   exec bash "$DIR/update.sh" --start ;;
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
          # Normalize legacy names
          case "$2" in release) ch=stable ;; main) ch=update ;; *) ch="$2" ;; esac
          printf '%s\n' "$ch" > "$DIR/data/update-channel"
          echo "Update channel set to: $ch" ;;
        *) echo "Channel must be 'stable' or 'update'."; exit 1 ;;
      esac
    fi ;;
  --help|-h) usage ;;
  *) echo "Unknown option: $1"; echo; usage; exit 1 ;;
esac
