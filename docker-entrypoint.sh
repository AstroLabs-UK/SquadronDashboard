#!/bin/sh
# Starts the dashboard as the unprivileged "node" user instead of root.
#
# ./data is bind-mounted from the host, and Docker creates a missing bind-mount folder owned by
# root - so the first thing to do (while still root) is hand that folder to "node", then drop
# privileges. If the container was started as a normal user already, just run the command.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data 2>/dev/null || true
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  fi
  exec runuser -u node -- "$@"
fi
exec "$@"
