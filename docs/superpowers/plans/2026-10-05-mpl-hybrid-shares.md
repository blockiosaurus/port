# PORT shares (mpl-hybrid) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every PORT is created inside its own sealed Core collection with an mpl-hybrid recipe, so the owner can lock it in escrow for 1,000,000 shares and any holder of the full supply can redeem it.

**Architecture:** `createPort` grows from 2 to 4 transactions (collection, asset, share mint → escrow, recipe + seal). A new `port-sdk/src/hybrid.ts` wraps `releaseV2`/`captureV2` with client-side guards. Existing Core calls (transfer, execute, identity registration) pass the collection when present; PORTs without one keep working with `shares: null`. The dashboard adds a fifth identity (Hybrid escrow) and a Shares card.

**Tech Stack:** TypeScript, umi 1.6, `@metaplex-foundation/mpl-core` 1.10, `@metaplex-foundation/mpl-hybrid` 0.2.0 (published), `mpl-toolbox` SPL helpers, Next.js 16 dashboard, vitest integration test on a localnet with real programs.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-05-mpl-hybrid-shares-design.md`.
- Share mint: SPL Token (not Token-2022), `SHARE_DECIMALS = 6`, `SHARE_SUPPLY = 1_000_000n * 10n ** 6n`, mint authority revoked after minting.
- Recipe: `amount = SHARE_SUPPLY`, all fees `0`, `feeLocation = creator`, `min = 0`, `max = 1`, `path = buildPath([Path.NoRerollMetadata])`, `name`/`uri` = the PORT's.
- Sealed collection authority: System Program `11111111111111111111111111111111`.
- mpl-hybrid program id `MPL4o4wMzndgh8T1NVDxELQCj5UQfYTYEkabX3wNKtb`; protocol fee wallet `C3iyKknpNPeZXQEVLkR8ZJxcgB8xdsqXkyrV1RwEmdrD` (client default).
- `releaseV2`/`captureV2` are called with `authority = recipe PDA` (no extra signer; path has no reroll).
- Pre-hybrid PORTs (no collection) must keep working everywhere (`collection: null`, `shares: null`).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run from the repo root: `pnpm typecheck`, `pnpm test`, `pnpm lint`. The lifecycle test needs `scripts/localnet.sh` running (RPC `http://127.0.0.1:18899`).

---

### Task 1: Dependency, program lists, hybrid SDK module

**Files:**
- Modify: `packages/port-sdk/package.json` (add `"@metaplex-foundation/mpl-hybrid": "^0.2.0"`)
- Modify: `scripts/lib/fork.ts:8-13` (add the hybrid program to `PORT_PROGRAMS`)
- Modify: `scripts/localnet.sh` (dump + load `MPL4o4…`)
- Create: `packages/port-sdk/src/hybrid.ts`
- Modify: `packages/port-sdk/src/index.ts` (export `./hybrid`)
- Modify: `packages/port-sdk/src/errors.ts` (add codes `NOT_TOKENIZABLE`, `ALREADY_TOKENIZED`, `NOT_TOKENIZED`, `INSUFFICIENT_SHARES`)

**Interfaces:**
- Produces:
  ```ts
  export const HYBRID_PROGRAM: PublicKey; export const SEALED_AUTHORITY: PublicKey; export const SHARE_DECIMALS = 6; export const SHARE_SUPPLY: bigint;
  export type PortShares = { collection; recipe; escrow; mint; decimals; supply; escrowBalance; tokenized; sealed };
  export function findEscrow(umi, authority: PublicKey): PublicKey;      // ["escrow", authority]
  export function findRecipe(umi, collection: PublicKey): PublicKey;     // ["recipe", collection]
  export function hybridSetupIxs(umi, input: { collection: PublicKey; shareMint: Signer; name; uri; escrowExists: boolean }): { mintTx: TransactionBuilder; recipeTx: TransactionBuilder }
  export async function fetchPortShares(umi, port: Pick<PortAccount,"asset"|"owner"|"collection">): Promise<PortShares | null>
  export async function tokenizePort(umi, asset: PublicKey): Promise<SentTx>
  export async function redeemPort(umi, asset: PublicKey): Promise<SentTx>
  export async function shareBalance(umi, mint: PublicKey, owner: PublicKey): Promise<bigint>
  export async function transferShares(umi, mint: PublicKey, to: PublicKey, amount: bigint): Promise<SentTx>
  ```

- [ ] **Step 1: Add the dependency and program ids**

```bash
cd packages/port-sdk && pnpm add @metaplex-foundation/mpl-hybrid@^0.2.0
```
In `scripts/lib/fork.ts` append `"MPL4o4wMzndgh8T1NVDxELQCj5UQfYTYEkabX3wNKtb", // mpl-hybrid (PORT shares)` to `PORT_PROGRAMS`. In `scripts/localnet.sh` add the id to the dump loop and a `--bpf-program MPL4o4… programs/MPL4o4….so` line.

- [ ] **Step 2: Write `hybrid.ts`**

```ts
import { publicKey, transactionBuilder, type PublicKey, type Signer, type TransactionBuilder, type Umi } from "@metaplex-foundation/umi";
import { string, publicKey as pkSer } from "@metaplex-foundation/umi/serializers";
import { fetchAsset, fetchCollection, updateCollectionV1 } from "@metaplex-foundation/mpl-core";
import { AuthorityType, createIdempotentAssociatedToken, createMint, findAssociatedTokenPda, mintTokensTo, safeFetchMint, safeFetchToken, setAuthority, transferTokens } from "@metaplex-foundation/mpl-toolbox";
import { buildPath, captureV2, initEscrowV2, initRecipeV1, Path, releaseV2, safeFetchEscrowV2, safeFetchRecipeV1 } from "@metaplex-foundation/mpl-hybrid";
import { PortError } from "./errors";
import { send, type PortAccount, type SentTx } from "./port";

export const HYBRID_PROGRAM = publicKey("MPL4o4wMzndgh8T1NVDxELQCj5UQfYTYEkabX3wNKtb");
export const SEALED_AUTHORITY = publicKey("11111111111111111111111111111111");
export const SHARE_DECIMALS = 6;
export const SHARE_SUPPLY = 1_000_000n * 10n ** BigInt(SHARE_DECIMALS);

export type PortShares = { collection: PublicKey; recipe: PublicKey; escrow: PublicKey; mint: PublicKey; decimals: number; supply: bigint; escrowBalance: bigint; tokenized: boolean; sealed: boolean };

const pda = (umi: Pick<Umi,"eddsa">, seed: string, key: PublicKey) => umi.eddsa.findPda(HYBRID_PROGRAM, [string({ size: "variable" }).serialize(seed), pkSer().serialize(key)])[0];
export const findEscrow = (umi, authority) => pda(umi, "escrow", authority);
export const findRecipe = (umi, collection) => pda(umi, "recipe", collection);
const shareAta = (umi, mint, owner) => findAssociatedTokenPda(umi, { mint, owner })[0];

/** Two builders: the share mint funded into the creator's escrow, then the immutable recipe + collection seal. */
export function hybridSetupIxs(umi: Umi, i: { collection: PublicKey; shareMint: Signer; name: string; uri: string; escrowExists: boolean }) {
  const creator = umi.identity.publicKey, escrow = findEscrow(umi, creator), escrowAta = shareAta(umi, i.shareMint.publicKey, escrow);
  let mintTx = transactionBuilder().add(createMint(umi, { mint: i.shareMint, decimals: SHARE_DECIMALS, mintAuthority: creator, freezeAuthority: null }));
  if (!i.escrowExists) mintTx = mintTx.add(initEscrowV2(umi, {}));
  mintTx = mintTx
    .add(createIdempotentAssociatedToken(umi, { mint: i.shareMint.publicKey, owner: escrow, ata: escrowAta }))
    .add(mintTokensTo(umi, { mint: i.shareMint.publicKey, token: escrowAta, amount: SHARE_SUPPLY }))
    .add(setAuthority(umi, { owned: i.shareMint.publicKey, owner: umi.identity, authorityType: AuthorityType.MintTokens, newAuthority: null }));
  const recipeTx = transactionBuilder()
    .add(initRecipeV1(umi, { collection: i.collection, token: i.shareMint.publicKey, feeLocation: creator, name: i.name, uri: i.uri, max: 1, min: 0, amount: SHARE_SUPPLY, feeAmountCapture: 0, feeAmountRelease: 0, solFeeAmountCapture: 0, solFeeAmountRelease: 0, path: buildPath([Path.NoRerollMetadata]) }))
    .add(updateCollectionV1(umi, { collection: i.collection, newUpdateAuthority: SEALED_AUTHORITY, newName: null, newUri: null }));
  return { mintTx, recipeTx };
}

export async function fetchPortShares(umi: Umi, port: Pick<PortAccount,"asset"|"owner"|"collection">): Promise<PortShares | null> {
  if (!port.collection) return null;
  const recipe = findRecipe(umi, port.collection);
  const r = await safeFetchRecipeV1(umi, recipe);
  if (!r) return null;
  const escrow = findEscrow(umi, r.authority);
  const [collection, mint, escrowTok] = await Promise.all([fetchCollection(umi, port.collection), safeFetchMint(umi, r.token), safeFetchToken(umi, shareAta(umi, r.token, escrow))]);
  return { collection: port.collection, recipe, escrow, mint: r.token, decimals: mint?.decimals ?? SHARE_DECIMALS, supply: r.amount, escrowBalance: escrowTok?.amount ?? 0n, tokenized: port.owner === escrow, sealed: collection.updateAuthority === SEALED_AUTHORITY };
}

async function sharesFor(umi: Umi, asset: PublicKey) {
  const { fetchPort } = await import("./port");  // avoid a circular import at module load
  const port = await fetchPort(umi, asset);
  const s = await fetchPortShares(umi, port);
  if (!s) throw new PortError("NOT_TOKENIZABLE", "This PORT was created without a share recipe.");
  return { port, s };
}

/** Owner locks the PORT in the hybrid escrow and receives the full share supply (releaseV2). */
export async function tokenizePort(umi: Umi, asset: PublicKey): Promise<SentTx> {
  const { port, s } = await sharesFor(umi, asset);
  if (s.tokenized) throw new PortError("ALREADY_TOKENIZED", "This PORT is already held by the share escrow.");
  if (port.owner !== umi.identity.publicKey) throw new PortError("NOT_AUTHORIZED", "Only the current owner can tokenize this PORT.");
  if (s.escrowBalance < s.supply) throw new PortError("INSUFFICIENT_SHARES", "The escrow does not hold the full share supply.");
  const r = await safeFetchRecipeV1(umi, s.recipe);
  return send(umi, releaseV2(umi, { owner: umi.identity, authority: s.recipe, recipe: s.recipe, escrow: s.escrow, asset, collection: s.collection, token: s.mint, feeProjectAccount: r!.feeLocation }));
}

/** A holder of the full supply pays it back into escrow and takes the PORT (captureV2). */
export async function redeemPort(umi: Umi, asset: PublicKey): Promise<SentTx> {
  const { s } = await sharesFor(umi, asset);
  if (!s.tokenized) throw new PortError("NOT_TOKENIZED", "This PORT is not in the share escrow.");
  const bal = await shareBalance(umi, s.mint, umi.identity.publicKey);
  if (bal < s.supply) throw new PortError("INSUFFICIENT_SHARES", `Redeeming needs the full supply (${s.supply}); this wallet holds ${bal}.`);
  const r = await safeFetchRecipeV1(umi, s.recipe);
  return send(umi, captureV2(umi, { owner: umi.identity, authority: s.recipe, recipe: s.recipe, escrow: s.escrow, asset, collection: s.collection, token: s.mint, feeProjectAccount: r!.feeLocation }));
}

export async function shareBalance(umi: Umi, mint: PublicKey, owner: PublicKey): Promise<bigint> {
  return (await safeFetchToken(umi, shareAta(umi, mint, owner)))?.amount ?? 0n;
}

export async function transferShares(umi: Umi, mint: PublicKey, to: PublicKey, amount: bigint): Promise<SentTx> {
  const from = umi.identity.publicKey, dest = shareAta(umi, mint, to);
  return send(umi, transactionBuilder()
    .add(createIdempotentAssociatedToken(umi, { mint, owner: to, ata: dest }))
    .add(transferTokens(umi, { source: shareAta(umi, mint, from), destination: dest, amount })));
}
```
Check the exact names exported by the hybrid client (`safeFetchRecipeV1`, `safeFetchEscrowV2`, `buildPath`, `Path`) and by mpl-toolbox (`setAuthority`, `AuthorityType`, `transferTokens`) against `node_modules` before relying on them; adjust imports, not semantics.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @port/port-sdk typecheck` (expect errors only about `PortAccount.collection`, fixed in Task 2).

- [ ] **Step 4: Commit**

```bash
git add packages/port-sdk scripts/lib/fork.ts scripts/localnet.sh pnpm-lock.yaml
git commit -m "port-sdk: mpl-hybrid share escrow helpers; clone the hybrid program on fork and localnet"
```

### Task 2: Creation inside a sealed collection; collection-aware transfer, execute, identity

**Files:**
- Modify: `packages/port-sdk/src/port.ts` (`PortAccount`, `createPort`, `completePortSetup`, `fetchPort`, `transferPort`)
- Modify: `packages/port-sdk/src/execute.ts` (`GuardedExecuteInput.collection?`, `buildGuardedExecute`, `guardedExecute`)
- Test: `packages/port-sdk/test/lifecycle.int.test.ts`

**Interfaces:**
- Produces: `PortAccount.collection: PublicKey | null`, `PortAccount.collectionAuthority: string | null`; `createPort` returns `{ ..., collection: PublicKey, shareMint: PublicKey }`; `GuardedExecuteInput.collection?: PublicKey`.

- [ ] **Step 1: Update the creation test expectations (fails first)**

In `lifecycle.int.test.ts` "creates a PORT…" replace `expect(port.updateAuthority).toBe("None")` with:
```ts
expect(port.updateAuthority).toBe("Collection");
expect(port.collection).toBe(res.collection);
expect(port.collectionAuthority).toBe(SEALED_AUTHORITY);
const shares = await fetchPortShares(base, port);
expect(shares).toMatchObject({ tokenized: false, sealed: true, supply: SHARE_SUPPLY, escrowBalance: SHARE_SUPPLY, mint: res.shareMint });
```
and import `SEALED_AUTHORITY, SHARE_SUPPLY, fetchPortShares` from `../src`.

- [ ] **Step 2: Implement `port.ts` changes**

```ts
// PortAccount: add
collection: PublicKey | null;          // Core collection (new PORTs); null for pre-hybrid PORTs
collectionAuthority: string | null;    // SEALED_AUTHORITY once sealed

// createPort
export async function createPort(umi, input): Promise<SentTx & { asset; signer; collection: PublicKey; shareMint: PublicKey; setupSignature: string }> {
  const asset = input.asset ?? generateSigner(umi);
  const collection = generateSigner(umi);
  const shareMint = generateSigner(umi);
  const signer = findPortSigner(umi, asset.publicKey);
  await send(umi, createCollection(umi, { collection, name: input.name, uri: input.uri }));
  const created = await send(umi, create(umi, { asset, collection: { publicKey: collection.publicKey }, name: input.name, uri: input.uri,
    plugins: [{ type: "Attributes", attributeList: encodeStrategy(input.strategy), authority: { type: "Owner" } }] }));
  const setup = await completePortSetup(umi, asset.publicKey, { ...input, shareMint });
  return { ...created, asset: asset.publicKey, signer, collection: collection.publicKey, shareMint: shareMint.publicKey, setupSignature: setup.signature };
}

// completePortSetup(umi, asset, input: Pick<CreatePortInput,"agentRegistrationUri"|"signerRentLamports"> & { name?: string; uri?: string; shareMint?: Signer })
//  1. raw = fetchAsset; collection = collectionAddress(raw) (throw NOT_A_PORT if missing)
//  2. recipe = safeFetchRecipeV1(findRecipe(collection)); escrowExists = !!safeFetchEscrowV2(findEscrow(identity))
//  3. if (!recipe): shareMint required → const { mintTx, recipeTx } = hybridSetupIxs(...); await send(mintTx)
//  4. b = transactionBuilder(); if (!identity) b.add(registerIdentityV1({ asset, collection, agentRegistrationUri }))
//     if (!recipe) b = b.add(recipeTx)   // initRecipe + seal
//     b.add(transferSol(... signer rent ...)); return send(b)
```
`fetchPort`: `collection: collectionAddress(raw) ?? null`; `collectionAuthority`: `collection ? (await fetchCollection(umi, collection)).updateAuthority : null`.
`transferPort`: `const col = collectionAddress(raw); transfer(umi, { asset: raw, newOwner, ...(col ? { collection: await fetchCollection(umi, col) } : {}) })`.

- [ ] **Step 3: Implement `execute.ts` changes**

`GuardedExecuteInput` gets `collection?: PublicKey`. `buildGuardedExecute` passes `...(input.collection ? { collection: { publicKey: input.collection } } : {})` to `execute`. `guardedExecute` always does `const port = await fetchPort(umi, input.asset)` first (owner check as today for owner mode) and calls `buildGuardedExecute(umi, { ...input, collection: port.collection ?? undefined })`. In the test's `tryExec`, pass `collection: (await fetchPort(umi, asset)).collection ?? undefined`.

- [ ] **Step 4: Run typecheck, then the lifecycle test on localnet**

```bash
pnpm typecheck
scripts/localnet.sh &   # once
pnpm --filter @port/port-sdk test
```
Expected: all 8 existing cases pass with the collection threaded through.

- [ ] **Step 5: Commit** — `git commit -m "PORT is created inside its own sealed collection with an mpl-hybrid share recipe"`

### Task 3: Tokenize / redeem lifecycle proof

**Files:**
- Test: `packages/port-sdk/test/lifecycle.int.test.ts` (append after the last case)

- [ ] **Step 1: Append the cases**

```ts
it("owner tokenizes: escrow owns the PORT, owner holds the full supply; delegate still executes", async () => {
  await delegateExecution(B.umi, asset, EXEC.s.publicKey);
  sigs.tokenize = (await tokenizePort(B.umi, asset)).signature;
  const port = await fetchPort(base, asset);
  const s = (await fetchPortShares(base, port))!;
  expect(s.tokenized).toBe(true);
  expect(port.owner).toBe(s.escrow);
  expect(await shareBalance(base, s.mint, B.s.publicKey)).toBe(SHARE_SUPPLY);
  expect(s.escrowBalance).toBe(0n);
  await expect(tryExec(B.umi, B.s, { authority: "owner" })).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  sigs.delegateWhileTokenized = (await tryExec(EXEC.umi, EXEC.s, { authority: "delegate" })).signature;
  await expect(tokenizePort(B.umi, asset)).rejects.toMatchObject({ code: "ALREADY_TOKENIZED" });
});

it("redeeming needs the full supply; the holder of all shares captures the PORT", async () => {
  const s = (await fetchPortShares(base, await fetchPort(base, asset)))!;
  await expect(redeemPort(A.umi, asset)).rejects.toMatchObject({ code: "INSUFFICIENT_SHARES" });
  await transferShares(B.umi, s.mint, A.s.publicKey, SHARE_SUPPLY);
  sigs.redeem = (await redeemPort(A.umi, asset)).signature;
  const port = await fetchPort(base, asset);
  expect(port.owner).toBe(A.s.publicKey);
  expect((await fetchPortShares(base, port))!).toMatchObject({ tokenized: false, escrowBalance: SHARE_SUPPLY });
  sigs.redeemedOwnerExecute = (await tryExec(A.umi, A.s, { authority: "owner" })).signature;
  await expect(tryExec(B.umi, B.s, { authority: "owner" })).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  await revokeExecution(A.umi, asset, EXEC.s.publicKey);
  console.log("PORT share signatures", sigs);
});
```
Move the `console.log("PORT lifecycle signatures"…)` from the revoke test to the end of the new last case.

- [ ] **Step 2: Run** `pnpm --filter @port/port-sdk test` → 10 cases pass. Note the on-chain `NOT_AUTHORIZED` mapping: if Core returns a different error for the escrow-owned case, assert on `PortError` instead and record the code in the test comment.
- [ ] **Step 3: Commit** — `git commit -m "Lifecycle proof: tokenize, delegate executes while escrowed, full-supply redeem"`

### Task 4: Snapshot, activity schema, scripts, verify

**Files:**
- Modify: `packages/shared/src/index.ts:62-70` (`ActivityAction` + zod enum add `"tokenize" | "redeem"`)
- Modify: `packages/integrations/src/agent.ts:28-36,53-67` (`PortSnapshot.shares`, `loadSnapshot`)
- Modify: `scripts/verify-demo.ts:22` (collection sealed check + shares check)
- Modify: `scripts/bootstrap-demo.ts` (log `collection`/`shareMint` into state) — only if `state` records creation fields; otherwise leave.

- [ ] **Step 1:** `PortSnapshot` gains `shares: PortShares | null`; `loadSnapshot` adds `fetchPortShares(ctx.umi, port)` to the `Promise.all`.
- [ ] **Step 2:** `verify-demo.ts`: replace the update-authority check with `check(port.collectionAuthority === SEALED_AUTHORITY, "Collection sealed (creator keeps no control)")` and `const shares = await fetchPortShares(umi, port); check(!!shares && shares.sealed && shares.supply === SHARE_SUPPLY, "mpl-hybrid share recipe (immutable, full-supply redeem)")`.
- [ ] **Step 3:** `pnpm typecheck && pnpm test` (unit tests in risk-engine/integrations/web still pass).
- [ ] **Step 4: Commit** — `git commit -m "Snapshot carries share state; activity gains tokenize/redeem; verify checks the sealed collection"`

### Task 5: Dashboard — escrow identity, Shares card, actions

**Files:**
- Modify: `apps/web/src/components/ui.tsx:9-16` (`IdentityKind` + `escrow` entry)
- Modify: `apps/web/src/app/globals.css` (`--escrow`, `--escrow-soft` light/dark; `@theme` colour alias if the others have one)
- Modify: `apps/web/src/lib/dto.ts` (`SnapshotDto.port.collection`, `collectionAuthority`; `shares: SharesDto | null`)
- Modify: `apps/web/src/lib/client.ts` (`actionTokenize`, `actionRedeem`, `sendShares`, `myShares`)
- Modify: `apps/web/src/app/port/[asset]/Dashboard.tsx` (Deed header line, `Shares` card, `ACTION_VERB`, modal)
- Modify: `apps/web/README.md` (fifth identity, Shares card)

- [ ] **Step 1: Identity + tokens**

`ui.tsx`: `escrow: { label: "Hybrid escrow", color: "var(--escrow)", soft: "var(--escrow-soft)", glyph: "▣", help: "mpl-hybrid escrow PDA. Owns the PORT while it is tokenized; only the full share supply can take it back." }`. `globals.css` light: `--escrow: #6d28d9; --escrow-soft: #e6ddf7;` dark: `--escrow: #b79cf0; --escrow-soft: #2a1d45;`. Add `IdentityLegend` entry if the legend iterates a fixed list.

- [ ] **Step 2: DTO + client actions**

```ts
export type SharesDto = { collection: string; recipe: string; escrow: string; mint: string; decimals: number; supply: Big; escrowBalance: Big; tokenized: boolean; sealed: boolean };
// SnapshotDto.port += collection: string | null; collectionAuthority: string | null;  SnapshotDto += shares: SharesDto | null
```
`client.ts`:
```ts
export const actionTokenize = async (umi, w, asset) => record(asset, w, "tokenize", await tokenizePort(umi, publicKey(asset)), { details: { from: w.signer.publicKey } });
export const actionRedeem   = async (umi, w, asset) => record(asset, w, "redeem",   await redeemPort(umi, publicKey(asset)),   { details: { to: w.signer.publicKey } });
export const sendShares = (umi, mint: string, to: string, amount: bigint) => transferShares(umi, publicKey(mint), publicKey(to), amount);
export const myShares   = (umi, mint: string, owner: string) => shareBalance(umi, publicKey(mint), publicKey(owner));
```

- [ ] **Step 3: Dashboard**

- Deed header: `update authority: {snap.port.collection ? "collection (sealed)" : snap.port.updateAuthority === "None" ? "none (sealed)" : short(...)}` with tooltip "The asset's update authority is its own collection, whose authority was handed to the System Program after the share recipe was initialised. Nobody can change the asset, the recipe or the fees."
- "Owned by" chip: `kind={snap.shares?.tokenized ? "escrow" : "owner"}`.
- New `Shares` card rendered in the second grid row (replace `<Mandate>` column with a stacked `<Mandate/>` + `<Shares/>`): shows mint chip, supply, escrow balance, the connected wallet's balance (fetched client-side via `myShares` in a `useEffect` keyed on `active`/`snap.shares?.mint`), state badge, copy from the spec, and buttons:
  - `Tokenize` (`isOwner && !tokenized`), `Send shares…` (balance > 0, opens a modal with recipient input defaulted to `other?.signer.publicKey` and amount defaulted to the full balance), `Redeem` (`tokenized && balance >= supply`).
  - `snap.shares === null` → "Created before share support; cannot be tokenized."
- `ACTION_VERB`: `tokenize: "Tokenized PORT (hybrid escrow)"`, `redeem: "Redeemed PORT from escrow"`.

- [ ] **Step 4: Verify in the browser** (fork running, `pnpm dev:fork`): create a PORT, Tokenize, Send shares to Wallet B, switch wallet, Redeem; confirm the deed chip flips owner→escrow→owner and activity rows appear. Screenshot for the evidence folder is optional.
- [ ] **Step 5:** `pnpm lint && pnpm typecheck && pnpm --filter @port/web build`
- [ ] **Step 6: Commit** — `git commit -m "Dashboard: Hybrid escrow identity and Shares card (tokenize, send, redeem)"`

### Task 6: README

**Files:** `README.md` (Test-it step 8, Solution table row, Security model row, "Why Solana" paragraph mention, package tree line for `hybrid.ts`), `apps/web/README.md`.

- [ ] Add step 8: "**Tokenize**: lock the PORT in an mpl-hybrid escrow and receive 1,000,000 shares. The agent keeps running under its delegation; nobody can touch the mandate. Send the shares to Wallet B and, as B, **Redeem** to take the account back out."
- [ ] Solution table: `| **Tokenize** | One mpl-hybrid releaseV2 locks the account for a fixed 1,000,000-share supply; captureV2 with the full supply redeems it. Terms are immutable: the collection authority is sealed after the recipe is initialised. |`
- [ ] Replace the "update authority is renounced" row with the collection-seal explanation; add the escrow identity row to the security table (colour violet ▣: can own the PORT while tokenized; cannot Execute, delegate, or change anything).
- [ ] Commit — `git commit -m "README: tokenize a PORT with mpl-hybrid shares"`
