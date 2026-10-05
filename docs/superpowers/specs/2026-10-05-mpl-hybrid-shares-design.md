# Tokenize a PORT with mpl-hybrid (PORT shares)

**Status:** approved design, 2026-10-05. **Implementation note:** the published client
(`@metaplex-foundation/mpl-hybrid@0.2.0`) only ships the V1 escrow (`EscrowV1`, keyed
`["escrow", collection]`, with the swap terms on the escrow itself), not the V2 escrow + recipe
described below. V1 has the same authority rule (`initEscrowV1`/`updateEscrowV1` need the
collection authority's signature), so the design holds with "recipe" read as "the escrow's own
terms" and one escrow per PORT instead of one per creator. The deployed program checks the V1
swap's protocol fee wallet against `C3iy…` (the client defaults to the older `GjF4…`); the SDK
defaults to the former and retries once with whatever wallet Anchor's constraint log names.

## Goal

A PORT owner can lock the whole account in an mpl-hybrid escrow and receive a fixed supply of
fungible **shares**. Whoever later holds the entire supply can capture the PORT back out. Nothing
custom runs on-chain: mpl-hybrid (`MPL4o4wMzndgh8T1NVDxELQCj5UQfYTYEkabX3wNKtb`) does the swap,
Metaplex Core does the transfer, and the Asset Signer never moves.

While a PORT is escrowed:
- the escrow PDA is the Core owner, so manual trades, mandate edits, delegation changes and
  transfers are impossible (Core rejects them on-chain);
- live execution delegations keep working (records survive the transfer), so the agent keeps
  running the mandate for the shareholders;
- the mandate is effectively frozen until someone redeems.

## Why it has to be set up at creation

mpl-hybrid keys a recipe by **Core collection** and only swaps assets whose update authority is
`Collection(recipe.collection)`. PORTs are currently created collection-less with update authority
`None`, and Core cannot move an authority-less asset into a collection later. So every PORT is now
created inside its own one-asset collection with the swap terms fixed at creation.

Decisions taken (user-approved):
1. **Every PORT** gets the hybrid setup at creation (no opt-in flag).
2. **Sealed terms**: after `initRecipeV1`, the collection's update authority is set to the System
   Program. `updateRecipeV1` requires the collection authority's signature, so amount, fees and path
   become immutable. This replaces today's "update authority: none (sealed)" property with an
   equivalent one: the asset's update authority is its collection, and the collection's authority is
   a key nobody holds.
3. **Client**: the published `@metaplex-foundation/mpl-hybrid@0.2.0` (its umi peer range is `<1`;
   PORT runs umi 1.6; the generated code is version-agnostic, pnpm will warn).

## On-chain layout per PORT

| Account | Derivation | Notes |
| --- | --- | --- |
| Collection | fresh signer | name = PORT name, uri = PORT uri, update authority → System Program after setup |
| PORT asset | fresh signer | `update_authority = Collection(collection)`, owner-managed Attributes plugin as today |
| Share mint | fresh signer, SPL Token (not 2022) | 6 decimals, supply **1,000,000.000000**, mint authority revoked after minting; no token-metadata (keeps localnet self-contained) |
| EscrowV2 | `["escrow", creator]` (mpl-hybrid) | one per creator, shared by every PORT they create; created idempotently (skip if it exists) |
| Recipe | `["recipe", collection]` (mpl-hybrid) | `token = share mint`, `amount = full supply`, `fee_amount_* = 0`, `sol_fee_amount_* = 0`, `fee_location = creator`, `min = 0, max = 1`, `path = NoRerollMetadata` |
| Escrow share ATA | ATA(share mint, escrow) | holds the full supply until the PORT is released into escrow |

Only the protocol's fixed SOL fee (`get_protocol_fee()` ≈ 0.005 SOL, paid to the mpl-hybrid fee
wallet) remains on each swap.

## Creation flow (`createPort`)

Four transactions (today: two). All idempotent-safe to retry through `completePortSetup`.

1. `createCollection` (authority = creator).
2. `create` asset inside the collection with the Attributes plugin (unchanged payload; the mandate
   nearly fills a transaction on its own, which is why the collection is separate).
3. Share mint: `createMint(6 decimals)` + `initEscrowV2` (only if the creator's escrow is missing) +
   `createIdempotentAssociatedToken(escrow)` + `mintTokensTo(escrow ATA, supply)` + `setAuthority(mint
   authority → none)`.
4. `registerIdentityV1` (now passes `collection`) + `initRecipeV1` + `updateCollectionV1(newUpdateAuthority
   = System Program)` + `transferSol` rent seed to the Asset Signer.

`completePortSetup` performs steps 3–4, skipping whatever already exists (escrow, mint supply,
recipe, sealed collection, identity).

## SDK (`packages/port-sdk/src/hybrid.ts`, new)

```ts
export const SHARE_DECIMALS = 6;
export const SHARE_SUPPLY = 1_000_000n * 10n ** 6n;
export const HYBRID_ESCROW_SEALED_AUTHORITY = "11111111111111111111111111111111";

export type PortShares = {
  collection: PublicKey; recipe: PublicKey; escrow: PublicKey; mint: PublicKey;
  decimals: number; supply: bigint;            // from the recipe (amount) and the mint
  escrowBalance: bigint;                       // shares still in escrow (supply when not tokenized)
  tokenized: boolean;                          // asset.owner === escrow
  sealed: boolean;                             // collection.updateAuthority === System Program
};

fetchPortShares(umi, port): Promise<PortShares | null>   // null for pre-hybrid PORTs (no collection / no recipe)
tokenizePort(umi, asset): Promise<SentTx>                // releaseV2 as owner; authority account = recipe PDA (no extra signer)
redeemPort(umi, asset): Promise<SentTx>                  // captureV2 as the connected wallet; authority account = recipe PDA
shareBalance(umi, mint, owner): Promise<bigint>
transferShares(umi, mint, to, amount): Promise<SentTx>   // demo helper (Wallet A → Wallet B)
```

Client-side guards (mirroring the on-chain rules so errors are explained before signing):
- `tokenizePort`: caller must be the Core owner; refuses if already tokenized; refuses when
  `escrowBalance < supply`.
- `redeemPort`: caller's share balance must be ≥ `supply`; refuses when not tokenized.

Changes to existing SDK code:
- `PortAccount` gains `collection: PublicKey | null` and `collectionAuthority: string | null`;
  `updateAuthority` keeps its current meaning (`"Collection"` for new PORTs, `"None"` for old ones).
- `transferPort`, `buildGuardedExecute`/`guardedExecute` and `registerIdentityV1` pass the collection
  when the PORT has one (`GuardedExecuteInput.collection?: PublicKey`). Pre-hybrid PORTs keep working.
- `BASE_PROGRAM_ALLOWLIST` is unchanged: shares never move through Core Execute.

## Integrations and server

- `PortSnapshot` gains `shares: PortShares | null`; `loadSnapshot` fetches it alongside delegates.
- `PortActivity.action` gains `"tokenize"` and `"redeem"`. Both transactions touch the asset, so the
  existing activity verification (actor signed, tx touched the PORT) already covers them. Share
  transfers between wallets are not recorded.
- Fork: add the mpl-hybrid program to `PORT_PROGRAMS` so `prepare-fork` clones it (upgradeable
  loader, cloned with its ProgramData). Localnet: dump it from devnet with the other programs.
- `verify-demo.ts`: the "update authority renounced" check becomes "collection sealed".

## Dashboard

- A fifth identity, **Hybrid escrow** (new `IdentityChip` kind `escrow`, slate/plum colour, glyph ▣),
  is used wherever the escrow PDA appears, including the "Owned by" slot when tokenized.
- Deed header: `update authority: collection (sealed)` with a tooltip explaining the seal.
- New **Shares** card beneath the agent panel: share mint, supply, connected wallet's balance,
  escrow balance, state ("held by owner" / "tokenized · escrow owns the PORT"). Actions:
  - **Tokenize** (owner, not tokenized): `tokenizePort`, toast with the signature.
  - **Send shares** (any holder; modal with recipient defaulted to the other demo wallet): `transferShares`.
  - **Redeem** (holder of the full supply, tokenized): `redeemPort`.
  - Explanatory copy: while tokenized nobody can trade manually or change the mandate; the agent keeps
    running under its delegation; collecting all 1,000,000 shares redeems the account.
- Owner-only buttons already disable when the escrow owns the PORT (the connected wallet isn't the owner).
- Pre-hybrid PORTs show "Created before share support; cannot be tokenized."

## Tests

- `lifecycle.int.test.ts` (localnet, real programs): creation asserts the collection is sealed and
  the recipe matches the spec; new cases appended after the existing delegation-persistence test
  (owner is B at that point):
  1. B re-delegates and tokenizes: owner becomes the escrow, B holds the full supply.
  2. B's owner Execute is rejected on-chain; the delegate's Execute still succeeds while escrowed.
  3. A cannot redeem with zero shares (client guard and on-chain).
  4. B sends the supply to A; A redeems: owner is A, escrow holds the supply again.
  5. A executes; B is rejected.
- Unit tests for the client guards (`tokenizePort`/`redeemPort` refusals) with mocked fetches are not
  worth a harness: they are covered by the integration test's negative cases.

## Docs

- README: new property row ("Tokenize: lock the PORT in an mpl-hybrid escrow for 1,000,000 shares;
  the full supply redeems it"), step 8 in "Test it in five minutes", a security-model row for the
  escrow identity, and the updated sealing explanation.
- `apps/web/README.md`: the fifth identity and the Shares card.

## Out of scope

- Token-metadata for the share mint, a market for shares (the Meteora DBC adapter exists but is
  not wired to shares), partial redemption, and any migration of pre-hybrid PORTs.
