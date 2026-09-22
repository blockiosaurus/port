#!/usr/bin/env bash
# Fresh demo ledger: re-clone the current mainnet state of every program/pool PORT touches,
# restart the fork validator on :28899 and wait for it. Clears local activity and demo state.
set -euo pipefail
cd "$(dirname "$0")/.."
pkill -f "solana-test-validator.*28899" 2>/dev/null || true
npx tsx scripts/prepare-fork.ts
rm -f .demo/activity.json .demo/state.json
nohup bash .demo/fork/validator.sh > .demo/fork/validator.log 2>&1 &
for _ in $(seq 1 120); do
  if curl -s -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' http://127.0.0.1:28899 | grep -q '"ok"'; then
    echo "Fork ready on http://127.0.0.1:28899"; exit 0
  fi
  sleep 2
done
echo "Fork failed to start; see .demo/fork/validator.log" >&2; exit 1
