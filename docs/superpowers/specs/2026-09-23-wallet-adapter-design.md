# Wallet adapter for the PORT dashboard

**Goal.** Let a normal Solana user connect a browser wallet (Phantom, Solflare, Backpack, anything
implementing Wallet Standard) and use it as the "connected wallet" identity everywhere the dashboard
currently uses a burner: create, deposit, trade, delegate/revoke, transfer, faucet (fork only).

**Decision (approved).** Real wallet + burners on fork/localnet only. On live clusters the burners
are hidden and the connected wallet is the only identity.

## Design

- `Wallet` becomes `{ id, label, kind: "burner" | "external", signer }`. Every action already takes a
  `Wallet` and only uses `signer` (for signing) and `signer.publicKey`, so the action layer is
  unchanged. The external signer is `createSignerFromWalletAdapter(useWallet())` from
  `@metaplex-foundation/umi-signer-wallet-adapters`; transactions are still built and sent through
  the app's own umi RPC, the wallet only signs.
- `lib/wallets-model.ts` — pure `composeWallets({ burners, external, local, activeId })` →
  `{ wallets, active }`: burners only when `local`; external first when connected; active falls back
  to the first wallet when the stored id is not present. Unit-tested with vitest.
- `lib/wallet.tsx` — `Providers` (ConnectionProvider + WalletProvider(autoConnect, Wallet Standard
  auto-detect) + WalletModalProvider + an `EnvContext` fetched once from `/api/env`) and
  `WalletButton` (Connect / Disconnect, styled with the deed tokens; the react-ui modal is themed via
  CSS overrides in `globals.css`). `layout.tsx` wraps the app in `Providers`.
- `lib/client.ts` — `useWallets()` combines the burner store with `useWallet()` through
  `composeWallets`; `setActive(id)` replaces the `0 | 1` index; connecting an external wallet
  auto-selects it; `useEnv()` reads the context.
- `Shell` renders one tab per wallet plus `WalletButton`. `Dashboard`/`page.tsx` switch from indexes
  to ids; the transfer form suggests any other wallet; the transfer-proof "Connect as …" button works
  for any wallet in the list.
- Docs: README known-gaps lines updated; note that a wallet extension simulates against its own RPC,
  so on the fork it warns "may fail" before signing.

## Out of scope

Sign-in-with-Solana, wallet-specific adapters beyond Wallet Standard, mobile layout.
