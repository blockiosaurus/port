#!/usr/bin/env bash
# One command from a fresh clone to a running PORT dashboard on a local fork of Solana mainnet.
#
#   pnpm quickstart              reuse a healthy fork if one is already running
#   pnpm quickstart --reset      always rebuild the fork from current mainnet state
#   pnpm quickstart --no-market  skip launching the agent-token DBC market
#
# Everything runs locally against a cloned mainnet ledger. No real funds are ever spent.
set -euo pipefail
cd "$(dirname "$0")/.."

FORK_RPC="http://127.0.0.1:28899"
WEB_PORT="${WEB_PORT:-3100}"
RESET=0
MARKET=1
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    --no-market) MARKET=0 ;;
    -h | --help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
step() { printf "\n\033[1m▸ %s\033[0m\n" "$1"; }
warn() { printf "\033[33m⚠ %s\033[0m\n" "$1"; }
die() { printf "\033[31m✗ %s\033[0m\n" "$1" >&2; exit 1; }
healthy() { curl -s -m 3 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$FORK_RPC" 2>/dev/null | grep -q '"ok"'; }

step "Checking prerequisites"
command -v node >/dev/null || die "node is required (22+): https://nodejs.org"
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 22 ] || die "node 22+ is required (found $(node -v))"
command -v pnpm >/dev/null || die "pnpm is required: npm i -g pnpm"
command -v solana-test-validator >/dev/null ||
  die "solana-test-validator is required. Install the Solana CLI:
     sh -c \"\$(curl -sSfL https://release.anza.xyz/stable/install)\"
     then reopen your shell so it is on PATH."
[ -d node_modules ] || { echo "  installing dependencies…"; pnpm install; }
echo "  node $(node -v) · pnpm $(pnpm -v) · $(solana-test-validator --version | head -1)"

# lsof is absent on some minimal Linux images; the check is a courtesy, not a requirement.
if command -v lsof >/dev/null && lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port $WEB_PORT is already in use. Stop that process, or run WEB_PORT=3200 pnpm quickstart."
fi

mkdir -p .demo

step "Checking configuration"
[ -f .env ] || { cp .env.example .env; echo "  created .env from .env.example"; }
set -a; . ./.env; set +a
if [ -z "${PYTH_API_KEY:-}" ]; then
  if ! grep -qE '^DEV_PRICE_FALLBACK=1' .env; then
    # Pyth Hermes needs an API key; without one the risk engine fails closed and nothing can trade.
    # On a local fork we fall back to clearly labelled placeholder prices so the demo still runs.
    perl -pi -e 's/^DEV_PRICE_FALLBACK=.*/DEV_PRICE_FALLBACK=1/' .env
  fi
  warn "No PYTH_API_KEY set: using DEV FALLBACK prices (labelled in red in the UI)."
  echo "  For real Pyth pricing, get a key at https://pythdata.app and set PYTH_API_KEY in .env."
else
  echo "  Pyth API key found: live Pyth USDC/USD will gate every trade."
fi
MAINNET_RPC_URL="${MAINNET_RPC_URL:-https://api.mainnet-beta.solana.com}"
case "$MAINNET_RPC_URL" in
  *api.mainnet-beta.solana.com*) warn "Using the public mainnet RPC to build the fork; this is slow and rate-limited. Set MAINNET_RPC_URL in .env to your own RPC for a faster, more reliable setup." ;;
  *) echo "  Cloning mainnet state from your configured RPC." ;;
esac

if [ "$RESET" -eq 0 ] && healthy && [ -f .demo/fork/env.json ]; then
  step "Reusing the fork already running on :28899"
  echo "  Run 'pnpm quickstart --reset' for fresh pool state (recommended before a live demo)."
  STARTED_FORK=0
else
  step "Building the fork (clones Core, MPL Agent, Token-2022, Jupiter, the PreStocks pools and Meteora)"
  echo "  This takes a couple of minutes on the first run."
  bash scripts/demo-reset.sh
  STARTED_FORK=1
fi

cleanup() {
  if [ "${STARTED_FORK:-0}" -eq 1 ]; then
    printf "\nStopping the fork validator…\n"
    pkill -f "solana-test-validator.*28899" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [ "$MARKET" -eq 1 ]; then
  step "Launching the agent-token market (Meteora DBC, quoted in NVDAx)"
  if npx tsx --env-file-if-exists=.env scripts/launch-agent-market.ts >.demo/agent-market.log 2>&1; then
    echo "  $(grep -o 'pool [1-9A-HJ-NP-Za-km-z]*' .demo/agent-market.log | head -1)"
  else
    warn "Agent market launch failed (see .demo/agent-market.log). The rest of the demo is unaffected."
  fi
fi

step "Starting the dashboard"
cat <<EOF

  $(bold "Open http://localhost:$WEB_PORT") and try this:

    1. Faucet              fund the browser's Wallet A with SOL + fork USDC
    2. Create PORT         mints the Core asset; its Asset Signer will hold everything
    3. Deposit             2,500 USDC into the Asset Signer
    4. Trade → buy OPENAI  see every policy check, then sign it through Core Execute
    5. Delegate, Run agent the agent completes the mandate under delegated Execute
    6. Transfer PORT →     hand it to Wallet B; check the before/after proof
    7. As Wallet B         trade, then revoke the delegation you inherited

  Wallets are throwaway keys in this browser. Everything is a local fork of mainnet: real
  programs and real PreStocks pools, no real funds. Press Ctrl+C to stop.

EOF
# No exec: the EXIT trap must still run so Ctrl+C also stops the validator this script started.
RPC_URL="$FORK_RPC" PORT_CLUSTER=fork PORT="$WEB_PORT" pnpm --filter @port/web dev || true
