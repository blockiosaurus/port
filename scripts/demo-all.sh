#!/usr/bin/env bash
# One command: fresh mainnet fork → scripted PORT lifecycle → agent market → verification.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/demo-reset.sh
npx tsx scripts/bootstrap-demo.ts
npx tsx scripts/launch-agent-market.ts
npx tsx scripts/verify-demo.ts
mkdir -p docs/evidence
cp .demo/state.json docs/evidence/demo-state.json
cp .demo/activity.json docs/evidence/demo-activity.json
cp .demo/agent-market.json docs/evidence/agent-market-fork.json
