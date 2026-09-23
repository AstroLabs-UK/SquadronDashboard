#!/usr/bin/env bash
# setup.sh is now just another name for install.sh (they used to be identical copies).
#   curl -fsSL https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/Stable/setup.sh | bash
#   ./setup.sh
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || pwd)"
if [ -f "$HERE/install.sh" ]; then
  exec bash "$HERE/install.sh" "$@"
fi
exec bash -c "$(curl -fsSL https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/Stable/install.sh)" -- "$@"
