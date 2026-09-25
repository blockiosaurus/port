#!/usr/bin/env bash
# Fresh fork on the droplet: re-clone current mainnet state, restart the validator, relaunch the
# agent market, clear the activity log. Runs as the `port` user (sudo is limited to these units).
# Judges' PORTs and browser burners from before the reset stop resolving; that is the point.
set -euo pipefail
cd /opt/port
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
healthy() { curl -s -m 3 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' http://127.0.0.1:28899 2>/dev/null | grep -q '"ok"'; }

sudo systemctl stop port-fork
npx tsx --env-file-if-exists=.env scripts/prepare-fork.ts
rm -f .demo/activity.json .demo/state.json .demo/agent-market.json
sudo systemctl start port-fork
for _ in $(seq 1 150); do healthy && break; sleep 2; done
healthy || { echo "Fork failed to start: journalctl -u port-fork -n 50" >&2; exit 1; }
echo "Fork ready on :28899"

if npx tsx --env-file-if-exists=.env scripts/launch-agent-market.ts > .demo/agent-market.log 2>&1; then
  grep -o 'pool [1-9A-HJ-NP-Za-km-z]*' .demo/agent-market.log | head -1
else
  echo "Agent market launch failed (see .demo/agent-market.log); the rest of the demo is unaffected." >&2
fi
sudo systemctl restart port-web
