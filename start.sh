#!/bin/sh
set -eu

# Resolve the application directory even when launched from another directory.
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$APP_DIR"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 24 or newer must be installed and available on PATH.' >&2
  exit 1
fi

node --input-type=module -e '
  if (Number(process.versions.node.split(".")[0]) < 24) {
    console.error("Node.js 24 or newer is required.");
    process.exit(1);
  }
'

# exec forwards SIGINT/SIGTERM directly to the server for graceful shutdown.
exec node server.mjs
