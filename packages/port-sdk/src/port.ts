import {
  createNoopSigner,
  generateSigner,
  publicKey,
  transactionBuilder,
  type Instruction,
  type PublicKey,
  type Signer,
  type TransactionBuilder,
  type Umi,
} from "@metaplex-foundation/umi";
import { base58 } from "@metaplex-foundation/umi/serializers";
import { collectionAddress, create, createCollection, fetchAsset, fetchCollectionV1, findAssetSignerPda, transfer, updateCollectionV1, type AssetV1 } from "@metaplex-foundation/mpl-core";
import {
  createIdempotentAssociatedToken,
  findAssociatedTokenPda,
  safeFetchMint,
  safeFetchToken,
  transferSol,
  transferTokensChecked,
} from "@metaplex-foundation/mpl-toolbox";
import { findAgentIdentityV2Pda, registerIdentityV1, safeFetchAgentIdentityV2 } from "@metaplex-foundation/mpl-agent-registry";
import { PortStrategySchema, type PortStrategy } from "@port/shared";
import { safeFetchEscrowV1 } from "@metaplex-foundation/mpl-hybrid";
import { PortError, toPortError } from "./errors";
import { findEscrow, hybridSetupIxs, SEALED_AUTHORITY } from "./hybrid";

export const TOKEN_PROGRAM = publicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = publicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const ATTR_KIND = "port.kind";
const ATTR_VERSION = "port.version";
const ATTR_STRATEGY = "port.strategy";

export type PortAccount = {
  asset: PublicKey;
  name: string;
  uri: string;
  owner: PublicKey;
  /** Deterministic PDA that custodies every PORT position. */
  signer: PublicKey;
  /** "Collection" for PORTs created with share support; "None" for older, collection-less PORTs. */
  updateAuthority: string;
  /** The PORT's own one-asset Core collection (null for older PORTs). */
  collection: PublicKey | null;
  /** The collection's update authority: SEALED_AUTHORITY once the share escrow is locked in. */
  collectionAuthority: string | null;
  strategy: PortStrategy;
  agentIdentity: PublicKey | null;
  raw: AssetV1;
};

export type SentTx = { signature: string };

export async function send(umi: Umi, builder: TransactionBuilder): Promise<SentTx> {
  try {
    const res = await builder.sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    if (res.result.value.err) throw new PortError("TX_FAILED", `transaction failed: ${JSON.stringify(res.result.value.err)}`);
    return { signature: base58.deserialize(res.signature)[0] };
  } catch (e) {
    throw toPortError(e);
  }
}

export const findPortSigner = (umi: Pick<Umi, "eddsa" | "programs">, asset: PublicKey): PublicKey =>
  findAssetSignerPda(umi, { asset })[0];

const LIMIT_KEYS = [
  "minCashWeightBps", "rebalanceToleranceBps", "maxPositionWeightBps", "maxTradeNavBps", "maxPriceAgeSeconds", "maxSpreadBps",
  "closedMarketSpreadBps", "highVolatilityThresholdBps", "maxDailyNotionalBps", "maxSlippageBps", "maxTransferFeeBps",
] as const;

/**
 * Compact positional encoding so the mandate fits in a Core Attributes plugin inside one
 * transaction: {n: name, c: cash index, t: [[mint, symbol, weightBps, refBandBps|null]], l: limits}.
 */
export function encodeStrategy(strategy: PortStrategy): Array<{ key: string; value: string }> {
  const s = PortStrategySchema.parse(strategy);
  const compact = {
    n: s.name,
    c: s.targets.findIndex((t) => t.mint === s.cashMint),
    t: s.targets.map((t) => [t.mint, t.symbol, t.weightBps, t.maxReferenceDeviationBps ?? null]),
    l: LIMIT_KEYS.map((k) => s[k] ?? null),
  };
  return [
    { key: ATTR_KIND, value: "PORT" },
    { key: ATTR_VERSION, value: String(s.version) },
    { key: ATTR_STRATEGY, value: JSON.stringify(compact) },
  ];
}

export function decodeStrategy(attrs: Array<{ key: string; value: string }> | undefined): PortStrategy {
  const kind = attrs?.find((a) => a.key === ATTR_KIND)?.value;
  const json = attrs?.find((a) => a.key === ATTR_STRATEGY)?.value;
  if (kind !== "PORT" || !json) throw new PortError("NOT_A_PORT", "Asset has no PORT strategy attributes.");
  let expanded: unknown;
  try {
    const c = JSON.parse(json) as { n: string; c: number; t: Array<[string, string, number, number | null]>; l: Array<number | null> };
    const limits = Object.fromEntries(LIMIT_KEYS.map((k, i) => [k, c.l[i] ?? undefined]).filter(([, v]) => v !== undefined));
    expanded = {
      version: Number(attrs!.find((a) => a.key === ATTR_VERSION)?.value),
      name: c.n,
      cashMint: c.t[c.c]?.[0],
      targets: c.t.map(([mint, symbol, weightBps, band]) => ({ mint, symbol, weightBps, ...(band === null ? {} : { maxReferenceDeviationBps: band }) })),
      ...limits,
    };
  } catch {
    throw new PortError("INVALID_STRATEGY", "Strategy attribute is not valid PORT encoding.");
  }
  const parsed = PortStrategySchema.safeParse(expanded);
  if (!parsed.success) throw new PortError("INVALID_STRATEGY", parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

export type CreatePortInput = {
  name: string;
  uri: string;
  strategy: PortStrategy;
  agentRegistrationUri: string;
  /** Lamports moved to the Asset Signer for rent of its token accounts. */
  signerRentLamports?: bigint;
  asset?: Signer;
};

/**
 * Creates the PORT (four transactions; the mandate alone nearly fills one):
 *  1. a one-asset Core collection, update authority = creator for now;
 *  2. the Core asset inside it, owned by the caller, with the strategy in an owner-managed
 *     Attributes plugin (so the mandate travels with ownership and only the owner can edit it);
 *  3. the share mint and the collection's mpl-hybrid escrow, funded with the full supply;
 *  4. MPL Agent identity registration, the collection seal (authority → System Program, which
 *     also freezes the escrow terms), and SOL for the Asset Signer's token-account rent.
 */
export async function createPort(
  umi: Umi,
  input: CreatePortInput,
): Promise<SentTx & { asset: PublicKey; signer: PublicKey; collection: PublicKey; shareMint: PublicKey; setupSignature: string }> {
  const asset = input.asset ?? generateSigner(umi);
  const collection = generateSigner(umi);
  const shareMint = generateSigner(umi);
  const signer = findPortSigner(umi, asset.publicKey);
  await send(umi, createCollection(umi, { collection, name: input.name, uri: input.uri }));
  const created = await send(
    umi,
    create(umi, {
      asset,
      collection: { publicKey: collection.publicKey },
      name: input.name,
      uri: input.uri,
      plugins: [{ type: "Attributes", attributeList: encodeStrategy(input.strategy), authority: { type: "Owner" } }],
    }),
  );
  const setup = await completePortSetup(umi, asset.publicKey, { ...input, shareMint });
  return { ...created, asset: asset.publicKey, signer, collection: collection.publicKey, shareMint: shareMint.publicKey, setupSignature: setup.signature };
}

/**
 * Second half of creation (safe to retry: every step is skipped once it exists): share escrow,
 * MPL Agent identity, collection seal, Asset Signer rent. Must be called by the creator while
 * the collection is still unsealed.
 */
export async function completePortSetup(
  umi: Umi,
  asset: PublicKey,
  input: Pick<CreatePortInput, "agentRegistrationUri" | "signerRentLamports"> & { shareMint?: Signer },
): Promise<SentTx> {
  const signer = findPortSigner(umi, asset);
  const raw = await fetchAsset(umi, asset);
  const collection = collectionAddress(raw);
  if (!collection) throw new PortError("NOT_A_PORT", "PORT asset is not in a collection; it cannot carry a share escrow.");
  const [identity, escrow, col] = await Promise.all([
    safeFetchAgentIdentityV2(umi, findAgentIdentityV2Pda(umi, { asset })[0]),
    safeFetchEscrowV1(umi, findEscrow(umi, collection)),
    fetchCollectionV1(umi, collection),
  ]);
  if (!escrow) {
    if (!input.shareMint) throw new PortError("TX_FAILED", "A share mint signer is required to initialise the share escrow.");
    await send(umi, await hybridSetupIxs(umi, { collection, shareMint: input.shareMint, name: raw.name, uri: raw.uri }));
  }
  let b = transactionBuilder();
  if (!identity) b = b.add(registerIdentityV1(umi, { asset, collection, agentRegistrationUri: input.agentRegistrationUri }));
  if (col.updateAuthority !== SEALED_AUTHORITY)
    b = b.add(updateCollectionV1(umi, { collection, newUpdateAuthority: SEALED_AUTHORITY, newName: null, newUri: null }));
  b = b.add(transferSol(umi, { destination: signer, amount: { basisPoints: input.signerRentLamports ?? 50_000_000n, identifier: "SOL", decimals: 9 } }));
  return send(umi, b);
}

export async function fetchPort(umi: Umi, asset: PublicKey): Promise<PortAccount> {
  let raw: AssetV1;
  try {
    raw = await fetchAsset(umi, asset);
  } catch {
    throw new PortError("NOT_A_PORT", `No Core asset at ${asset}.`);
  }
  const strategy = decodeStrategy(raw.attributes?.attributeList);
  const identityPda = findAgentIdentityV2Pda(umi, { asset })[0];
  const collection = collectionAddress(raw) ?? null;
  const [identity, col] = await Promise.all([safeFetchAgentIdentityV2(umi, identityPda), collection ? fetchCollectionV1(umi, collection) : null]);
  return {
    asset,
    name: raw.name,
    uri: raw.uri,
    owner: raw.owner,
    signer: findPortSigner(umi, asset),
    updateAuthority: raw.updateAuthority.type === "Address" ? raw.updateAuthority.address! : raw.updateAuthority.type,
    collection,
    collectionAuthority: col?.updateAuthority ?? null,
    strategy,
    agentIdentity: identity ? identityPda : null,
    raw,
  };
}

export async function transferPort(umi: Umi, asset: PublicKey, newOwner: PublicKey): Promise<SentTx> {
  const raw = await fetchAsset(umi, asset);
  if (raw.owner !== umi.identity.publicKey) throw new PortError("NOT_AUTHORIZED", "Only the current owner can transfer this PORT.");
  const col = collectionAddress(raw);
  return send(umi, transfer(umi, { asset: raw, newOwner, ...(col ? { collection: await fetchCollectionV1(umi, col) } : {}) }));
}

export type MintInfo = { mint: PublicKey; decimals: number; tokenProgram: PublicKey };

export async function fetchMintInfo(umi: Umi, mint: PublicKey): Promise<MintInfo> {
  const acct = await umi.rpc.getAccount(mint);
  if (!acct.exists) throw new PortError("TX_FAILED", `Mint ${mint} does not exist on this cluster.`);
  const m = await safeFetchMint(umi, mint);
  if (!m) throw new PortError("TX_FAILED", `Account ${mint} is not an SPL mint.`);
  return { mint, decimals: m.decimals, tokenProgram: acct.owner };
}

export const ataFor = (umi: Pick<Umi, "eddsa" | "programs">, mint: MintInfo, owner: PublicKey): PublicKey =>
  findAssociatedTokenPda(umi, { mint: mint.mint, owner, tokenProgramId: mint.tokenProgram })[0];

export type Balance = { mint: string; symbol: string; decimals: number; amount: bigint; tokenAccount: string; tokenAccountOwner: string | null };

/** Reads every strategy mint's balance held by the Asset Signer, verifying token-account ownership. */
export async function fetchPortBalances(umi: Umi, port: Pick<PortAccount, "signer" | "strategy">): Promise<Balance[]> {
  return Promise.all(
    port.strategy.targets.map(async (t) => {
      const info = await fetchMintInfo(umi, publicKey(t.mint));
      const ata = ataFor(umi, info, port.signer);
      const tok = await safeFetchToken(umi, ata);
      if (tok && tok.owner !== port.signer) throw new PortError("UNEXPECTED_SIGNER", `Token account ${ata} is not owned by the Asset Signer.`);
      return { mint: t.mint, symbol: t.symbol, decimals: info.decimals, amount: tok?.amount ?? 0n, tokenAccount: ata, tokenAccountOwner: tok?.owner ?? null };
    }),
  );
}

/** Wallet → Asset Signer deposit. The ATA is created idempotently and owned by the signer. */
export async function depositToPort(umi: Umi, port: Pick<PortAccount, "signer">, mint: PublicKey, amount: bigint): Promise<SentTx> {
  const info = await fetchMintInfo(umi, mint);
  const from = ataFor(umi, info, umi.identity.publicKey);
  const to = ataFor(umi, info, port.signer);
  return send(
    umi,
    transactionBuilder()
      .add(createIdempotentAssociatedToken(umi, { mint, owner: port.signer, ata: to, tokenProgram: info.tokenProgram }))
      .add(checkedTransfer(umi, info, { source: from, destination: to, amount, authority: umi.identity })),
  );
}

/** Instruction that moves tokens out of the Asset Signer; only valid when wrapped in Core Execute. */
export function signerTokenTransferIx(umi: Umi, port: Pick<PortAccount, "signer">, mint: MintInfo, destinationOwner: PublicKey, amount: bigint): Instruction[] {
  const noop = createNoopSigner(port.signer);
  return checkedTransfer(umi, mint, {
    source: ataFor(umi, mint, port.signer),
    destination: ataFor(umi, mint, destinationOwner),
    amount,
    authority: noop,
  }).getInstructions();
}

/** TransferChecked for either SPL Token or Token-2022 (identical instruction layout). */
function checkedTransfer(
  umi: Umi,
  mint: MintInfo,
  a: { source: PublicKey; destination: PublicKey; amount: bigint; authority: Signer },
): TransactionBuilder {
  const b = transferTokensChecked(umi, { ...a, mint: mint.mint, decimals: mint.decimals });
  if (mint.tokenProgram === TOKEN_PROGRAM) return b;
  return b.mapInstructions((i) => ({ ...i, instruction: { ...i.instruction, programId: mint.tokenProgram } }));
}
