# PORT dashboard

The web app is the demo surface for PORT: it shows who controls an account, what the policy engine
decided, and what the transfer actually changes. ~1,900 lines of TypeScript, Next.js 16 App Router,
Tailwind v4, no component library and no client state library.

```
src/
  app/
    layout.tsx           fonts + globals
    globals.css          design tokens (light/dark), card/button/input primitives, animations
    page.tsx             landing: thesis, mandate preview, create PORT, open a PORT
    port/[asset]/
      page.tsx           server component: awaits params, renders the client dashboard
      Dashboard.tsx      the whole dashboard (deed, positions, prices, mandate, agent, activity, modals)
    api/                 route handlers (Node runtime) — see "Server" below
  components/
    ui.tsx               IdentityChip, IdentityLegend, Seal, Checks, TxLink, Banner, Modal, Shell
    AgentMarket.tsx      Meteora DBC panel (curve progress, fees, design rationale)
  lib/
    server.ts            server-only config, key loading, agent context, JSON helpers   (never imported by the client)
    serialize.ts         PortSnapshot/EvaluatedTrade → wire DTOs (bigint → string)
    dto.ts               wire types shared by both sides
    client.ts            API helper, burner wallets, signed actions
    format.ts            addresses, USD, bps, token units, explorer links
```

## The one idea the UI has to carry

A PORT has four identities and they must never be confused. Each has a fixed colour, glyph and
tooltip, used everywhere (header, deed, activity rows, transfer proof):

| Identity | Colour | Glyph | Meaning |
| --- | --- | --- | --- |
| Connected wallet | blue-black | ◉ | who is signing in this browser right now |
| Core owner | vermilion | ◆ | owns the Core asset; moves on transfer |
| Asset Signer | verdigris | ⬢ | the PDA that holds every position; never moves |
| Agent executive | ochre | ✦ | may Execute under a revocable delegation |

`IdentityChip` is the only way an address is ever rendered, so the colour is always attached to the
role. The Asset Signer additionally gets `Seal`, an engraved SVG stamp with its address set around
the ring: the fixed point of the product, visually anchored while ownership changes around it.

The aesthetic is a title deed — paper background with an engraved rule pattern, Instrument Serif
display, Schibsted Grotesk body, JetBrains Mono for anything on-chain. Dark mode is token-swapped in
`globals.css`. Numbers use tabular figures so they don't jitter between refreshes.

## Client/server split (and why)

**The server holds one key and no user keys.** The agent executive's keypair is read from
`.keys/executive.json` by `lib/server.ts`, which is `import "server-only"` so it cannot be pulled
into a client bundle. The browser never sees it.

**The browser holds the user's keys and nothing else.** Demo wallets are burner keypairs generated
in the browser and stored in `localStorage` (`port.burners.v1`). They are read through
`useSyncExternalStore`, so the server render sees an empty list and hydration stays consistent.
They never leave the browser, and they are only appropriate for a fork/localnet demo.

**Quoting happens on the server; signing happens in the browser.** The server holds no user
authority, so an owner action is a two-step flow:

```
browser: "I want to buy $700 OPENAI, my pubkey is X"
   ↓ POST /api/trade/prepare
server:  load snapshot → plan/size → Jupiter quote → validate the route instruction bytes
         → run every policy check → return {decision, instructions, lookup tables}
   ↓
browser: re-check the program allowlist, wrap in Core Execute, sign with the burner, send
   ↓ POST /api/activity {signature}
server:  confirm on-chain that it succeeded, was signed by that actor and touched this PORT,
         then append to the activity log
```

The browser refuses to sign anything the policy did not approve (`actionTrade` throws when
`decision.allowed` is false), and `buildGuardedExecute` in `@port/port-sdk` re-checks the program
allowlist and inner signers before building the transaction. The activity log is therefore never
a claim: it is a record of transactions the server has verified.

## Routes

| Route | Method | Does |
| --- | --- | --- |
| `/api/env` | GET | Cluster, RPC, whether Pyth is configured, dev fallback, agent pubkey, faucet availability, the scripted demo asset. On local clusters it also makes sure the agent executive is funded and registered (never on live clusters). |
| `/api/port/[asset]` | GET | The full snapshot: port, balances, prices, valuation, delegates, Token-2022 profiles, warnings, plus the activity log. |
| `/api/trade/prepare` | POST | `{kind: "rebalance"}` or `{kind: "manual", side, symbol, notionalUsd}` → proposal with per-trade decisions and ready-to-sign instructions. Signs nothing. |
| `/api/agent/run` | POST | The agent executes approved trades via delegated Core Execute (`dryRun: true` plans only). Returns 403 `NOT_DELEGATED` when no delegate record exists. |
| `/api/activity` | GET/POST | Read the log; append a browser-signed action **after** on-chain verification. |
| `/api/faucet` | POST | Fork/localnet only: SOL + fork USDC from the demo treasury. Returns 403 on live clusters. |
| `/api/market` | GET | The agent-token DBC market: saved launch record plus live pool state. |

Everything is `force-dynamic`: the snapshot is live chain and market data, not cacheable.

`bigint` doesn't survive JSON, so `lib/serialize.ts` converts every amount to a decimal string and
`lib/dto.ts` types the wire format. Client code converts back with `BigInt(...)` only where it does
arithmetic; display helpers in `format.ts` take strings.

## Dashboard anatomy (`port/[asset]/Dashboard.tsx`)

One client component owns the page state: `view` (snapshot + activity), `busy` (which action is
running), `toast`, and whichever modal is open. It polls `/api/port/[asset]` every 30s and after
every action. Sub-components are pure presentation.

- **Deed** — name, asset address, `update authority: none (sealed)`, agent identity status; the four
  identities as chips; the Seal; NAV. Owner actions are disabled with an explanation when the
  connected wallet isn't the owner ("Execute would be rejected on-chain"), which mirrors what the
  chain would do rather than hiding the buttons.
- **Positions** — holding (converted to UI units with the mint's scaled-UI multiplier), value, and a
  weight bar with a target tick. Bars turn vermilion when drift exceeds the mandate's tolerance.
  Each row names the token account and its owner, so custody is visible, not asserted.
- **Prices & risk inputs** — per asset: price source, age, half-spread, reference source and
  deviation against its band. Values that breach a limit turn red; dev-fallback sources turn red
  too. Warnings (e.g. a Pyth feed the key isn't entitled to) are listed above the table.
- **Mandate** — the limits as stored on the asset, plus the program allowlist.
- **Agent** — what it may do, its executive identity, delegate/revoke, "Preview plan" and "Run
  agent". "Run agent" stays disabled until a delegation exists.
- **Activity** — newest first, each row showing status, action, actor chip, tx link, and rationale.
  Blocked entries show which checks failed; clicking a row expands the full check list and route.
- **AgentMarket** — DBC pool, curve progress toward graduation, fees accrued in the quote stock,
  ClawPump status, the design rationale, and the disclaimer.

### Modals

- **Review** (owner rebalance, manual trade, or agent run) — the plan rationale, then one card per
  trade: direction, notional, sizing reasons, route, minimum out, issuer fee, and all ~17 checks
  with observed/limit values. Approved trades can be signed; blocked ones cannot.
- **Deposit / Trade** — small forms; the trade form runs the same policy path as a rebalance.
- **Transfer** — states plainly what moves (ownership) and what doesn't (the Asset Signer and every
  position), warns that delegations carry over, and defaults the recipient to the other burner.
- **Transfer proof** — the finale. A before/after table of owner, Asset Signer, every position
  balance, the mandate and delegations, with "✓ unchanged" markers, a wax-stamp "CONVEYED"
  animation, and a button to connect as the new owner. The "before" snapshot is captured client-side
  before signing and compared against a fresh fetch afterwards, so it's a real diff.

## Conventions worth keeping

- **No optimistic UI.** Nothing is shown as done until the chain confirms and the snapshot refetches.
- **Fail-closed is visible.** When a price source is missing the UI says trades will fail closed, and
  a blocked trade names the failing checks instead of a generic error.
- **Errors are translated once.** `PortError` codes map to human sentences at the call site (e.g.
  `NOT_AUTHORIZED` → "Rejected on-chain: this wallet is neither the owner nor an active delegate").
- **Cluster is always on screen.** The header shows "Mainnet fork · local ledger", and dev-fallback
  pricing gets a red banner, so a screenshot can never imply mainnet.
- **Explorer links everywhere**, cluster-aware (custom RPC for fork/localnet).

## Running it

```bash
pnpm dev:fork     # http://localhost:3100 against the local fork (recommended)
pnpm dev          # follows .env
```

Config comes from the repo-root `.env` (loaded in `next.config.ts`); shell variables win. See the
root README for the fork setup, `pnpm demo`, and the demo video, which is recorded by driving this
UI with Playwright (`scripts/record-demo.ts`).

Known gaps: no wallet-adapter integration (burners only, fork-appropriate), the activity log is a
local JSON file, `/api/trade/prepare` can take ~30s on the free Jupiter tier because quotes are
paced (set `JUPITER_API_KEY` to speed it up), and there is no mobile-specific layout beyond the
responsive grid.
