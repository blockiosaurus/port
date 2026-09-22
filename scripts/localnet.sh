#!/usr/bin/env bash
# Local validator with the exact devnet builds of Core + MPL Agent programs.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p programs
for id in CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S 1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p SysExL2WDyJi9aRZrXorrjHJut3JwHQ7R9bTyctbNNG TokExjvjJmhKaRBShsBAsbSvEWMA1AgUNK7ps4SAc2p; do
  [ -f "programs/$id.so" ] || solana program dump -ud "$id" "programs/$id.so"
done
exec solana-test-validator --reset --quiet --ledger .demo/ledger --rpc-port 18899 --faucet-port 19900 --gossip-port 18000 --dynamic-port-range 18001-18030 \
  --bpf-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d programs/CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d.so \
  --bpf-program TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S programs/TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S.so \
  --bpf-program 1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p programs/1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p.so \
  --bpf-program SysExL2WDyJi9aRZrXorrjHJut3JwHQ7R9bTyctbNNG programs/SysExL2WDyJi9aRZrXorrjHJut3JwHQ7R9bTyctbNNG.so \
  --bpf-program TokExjvjJmhKaRBShsBAsbSvEWMA1AgUNK7ps4SAc2p programs/TokExjvjJmhKaRBShsBAsbSvEWMA1AgUNK7ps4SAc2p.so
