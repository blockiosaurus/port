# Hosting the fork demo on a DigitalOcean droplet

The public demo runs the same thing as `pnpm quickstart`: a local fork of Solana mainnet (real
programs, the real PreStocks pools, no real funds) plus the dashboard, on one droplet behind Caddy.
Judges need no wallet and no money: the header offers browser burner wallets and the faucet funds
them with SOL and fork USDC.

```
https://<domain>/        Next.js dashboard (next start on :3100)
https://<domain>/rpc     fork validator JSON-RPC (:28899) and websocket subscriptions (:28900)
```

The browser signs and sends its own transactions, so the fork's RPC has to be public and served over
HTTPS (the dashboard is HTTPS; browsers block mixed content). Caddy terminates TLS and routes
websocket upgrades on `/rpc` to the validator's pubsub port. Explorer links use
`explorer.solana.com/?cluster=custom&customUrl=https://<domain>/rpc`, so they work for anyone.

## 1. Create the droplet

Ubuntu 24.04, **4 vCPU / 8 GB** (the validator with ~640 cloned accounts needs the RAM; the ledger
uses ~20 GB of disk), SSH key auth. Note the public IP.

Optional: point a domain's A record at it. Without one, `<ip>.sslip.io` is used and works with
Let's Encrypt.

## 2. One-time setup (as root)

```bash
ssh root@<ip> bash -s < deploy/setup-droplet.sh
# or with a domain:
ssh root@<ip> PORT_DOMAIN=port.example.com bash -s < deploy/setup-droplet.sh
```

Installs Node 22, pnpm, Caddy, Agave `v3.1.14` (for `solana-test-validator`), a `port` service user,
and a firewall that exposes only SSH, 80 and 443.

## 3. Deploy (from your machine, repeatable)

```bash
pnpm deploy:sync root@<ip>            # rsync the tree, pnpm install, next build, install services
pnpm deploy:sync root@<ip> --reset    # same, plus rebuild the fork from current mainnet state
```

The first run builds the fork (clones from `MAINNET_RPC_URL` in `.env`; a private RPC makes this a
couple of minutes instead of much longer), launches the NVDAx-quoted agent market, and starts
everything. `.env` and `.keys/` are synced because the server needs the Pyth/Jupiter/ClawPump keys
and the agent executive key; `.demo/` is not, the droplet keeps its own fork state.

Check:

```bash
curl https://<domain>/api/health     # node version, cluster
curl https://<domain>/api/env        # executive registered, faucet: true, rpcUrl: https://<domain>/rpc
```

## Operating it

| Task | Command |
| --- | --- |
| Fresh fork (wipes judges' PORTs, activity, burners' balances) | `pnpm deploy:sync root@<ip> --reset` |
| Ship a code change | `pnpm deploy:sync root@<ip>` |
| Logs | `ssh root@<ip> journalctl -u port-web -u port-fork -u caddy -f` |
| Validator log | `ssh root@<ip> tail -f /opt/port/.demo/fork/validator.log` (systemd captures stdout; use `journalctl -u port-fork`) |

Notes:

- `port-fork.service` starts the validator with `--reset`, so any restart of that unit (including
  an automatic restart after a crash) is a clean ledger. Prefer `deploy/reset-fork.sh`, which also
  clears the activity log and relaunches the agent market, so the UI and the chain agree.
- Jupiter quotes mainnet pools while trades move the cloned pools. After several buys of the same
  name on one fork the on-chain min-out check starts rejecting (correctly). That is the risk engine
  and the route guard doing their jobs, not a bug; try another name, a smaller size, or reset.
- The fork is a snapshot: pool prices drift from mainnet over time. The reference prices (Pyth,
  PreStocks marks) are live, so the spread check tightens as the snapshot ages. Reset daily during
  judging if you can.
- Nothing here touches mainnet. The faucet, burners, and the agent's self-registration are
  fork-only code paths that the server refuses on live clusters.
