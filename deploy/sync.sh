#!/usr/bin/env bash
# Push this working tree to the droplet, build, and (re)start the dashboard.
#
#   pnpm deploy:sync root@<ip>            first run also builds the fork (several minutes)
#   pnpm deploy:sync root@<ip> --reset    rebuild the fork from current mainnet state
#
# Syncs .env and .keys/ (the server needs them); never syncs node_modules, .next, .demo or .git.
# The droplet keeps its own .demo/ (fork script, ledger, activity log, agent market).
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${1:?usage: deploy/sync.sh root@<droplet-ip> [--reset]}"
RESET="${2:-}"

rsync -az --delete -e ssh \
  --exclude node_modules --exclude .next --exclude .git --exclude .demo --exclude test-ledger \
  --exclude '*.tsbuildinfo' --exclude .DS_Store \
  ./ "$HOST:/opt/port/"

ssh "$HOST" "PORT_RESET='$RESET' bash /opt/port/deploy/remote-install.sh"
