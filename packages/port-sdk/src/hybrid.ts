/**
 * PORT shares: an mpl-hybrid (MPL-404) escrow per PORT.
 *
 * Every PORT lives in its own one-asset Core collection. At creation the creator mints a fixed
 * share supply into the collection's hybrid escrow and seals the collection (update authority →
 * System Program), which makes the escrow terms immutable: `updateEscrowV1` needs the collection
 * authority's signature, and nobody holds it.
 *
 *  - tokenize  = releaseV1: the owner locks the PORT in escrow and receives the full supply.
 *  - redeem    = captureV1: whoever holds the full supply pays it back and takes the PORT.
 *
 * The escrow only ever signs Core transfers, so while a PORT is tokenized nobody can trade,
 * edit the mandate or delegate; live execution delegations keep working for the agent.
 */
import { publicKey, transactionBuilder, type PublicKey, type Signer, type TransactionBuilder, type Umi } from "@metaplex-foundation/umi";
import { publicKey as pkSer, string } from "@metaplex-foundation/umi/serializers";
import { fetchCollectionV1 } from "@metaplex-foundation/mpl-core";
import {
  AuthorityType, createAccount, createIdempotentAssociatedToken, findAssociatedTokenPda, getMintSize, initializeMint2, mintTokensTo, safeFetchMint, safeFetchToken, setAuthority,
  transferTokens,
} from "@metaplex-foundation/mpl-toolbox";
import { captureV1, initEscrowV1, releaseV1, safeFetchEscrowV1 } from "@metaplex-foundation/mpl-hybrid";
import { PortError } from "./errors";
import { fetchPort, send, TOKEN_PROGRAM, type PortAccount, type SentTx } from "./port";

export const HYBRID_PROGRAM = publicKey("MPL4o4wMzndgh8T1NVDxELQCj5UQfYTYEkabX3wNKtb");
/**
 * Protocol fee wallet (a fixed ~0.005 SOL per swap). The deployed program checks this against a
 * constant that has changed between builds (the published client still defaults to the older
 * one), so swaps retry once with the wallet Anchor names in its constraint log if it differs.
 */
export const HYBRID_FEE_WALLET = publicKey("C3iyKknpNPeZXQEVLkR8ZJxcgB8xdsqXkyrV1RwEmdrD");
/** A key nobody holds: the collection authority is handed here once the escrow is initialised. */
export const SEALED_AUTHORITY = publicKey("11111111111111111111111111111111");
export const SHARE_DECIMALS = 6;
export const SHARE_SUPPLY = 1_000_000n * 10n ** BigInt(SHARE_DECIMALS);
/** Escrow path bit 0 = NoRerollMetadata: swaps never touch the asset's name or URI. */
const PATH_NO_REROLL = 1;

export type PortShares = {
  collection: PublicKey;
  escrow: PublicKey;
  mint: PublicKey;
  decimals: number;
  /** Shares paid out on tokenize and required to redeem (the whole supply). */
  supply: bigint;
  /** Shares still sitting in the escrow: the supply when not tokenized, 0 when tokenized. */
  escrowBalance: bigint;
  /** The escrow PDA owns the Core asset. */
  tokenized: boolean;
  /** Collection authority is the System Program: escrow terms can never change. */
  sealed: boolean;
};

export const findEscrow = (umi: Pick<Umi, "eddsa">, collection: PublicKey): PublicKey =>
  umi.eddsa.findPda(HYBRID_PROGRAM, [string({ size: "variable" }).serialize("escrow"), pkSer().serialize(collection)])[0];

const shareAta = (umi: Pick<Umi, "eddsa" | "programs">, mint: PublicKey, owner: PublicKey) => findAssociatedTokenPda(umi, { mint, owner })[0];

/**
 * One transaction: SPL share mint (6 dp) → hybrid escrow for the collection (terms: full supply
 * per swap, zero project fees, no metadata reroll) → full supply minted to the escrow → mint
 * authority revoked. Must run while the caller is still the collection authority. The mint is
 * created with plain System + Token instructions (rent read client-side) so nothing beyond Core,
 * mpl-hybrid, SPL Token and the ATA program is needed on-chain.
 */
export async function hybridSetupIxs(umi: Umi, i: { collection: PublicKey; shareMint: Signer; name: string; uri: string }): Promise<TransactionBuilder> {
  const creator = umi.identity.publicKey;
  const escrow = findEscrow(umi, i.collection);
  const escrowAta = shareAta(umi, i.shareMint.publicKey, escrow);
  const space = getMintSize();
  const lamports = await umi.rpc.getRent(space);
  return transactionBuilder()
    .add(createAccount(umi, { newAccount: i.shareMint, lamports, space, programId: TOKEN_PROGRAM }))
    .add(initializeMint2(umi, { mint: i.shareMint.publicKey, decimals: SHARE_DECIMALS, mintAuthority: creator, freezeAuthority: null }))
    .add(
      initEscrowV1(umi, {
        escrow, collection: i.collection, token: i.shareMint.publicKey, feeLocation: creator,
        name: i.name, uri: i.uri, max: 1, min: 0, amount: SHARE_SUPPLY, feeAmount: 0, solFeeAmount: 0, path: PATH_NO_REROLL,
      }),
    )
    .add(createIdempotentAssociatedToken(umi, { mint: i.shareMint.publicKey, owner: escrow, ata: escrowAta }))
    .add(mintTokensTo(umi, { mint: i.shareMint.publicKey, token: escrowAta, amount: SHARE_SUPPLY }))
    .add(setAuthority(umi, { owned: i.shareMint.publicKey, owner: umi.identity, authorityType: AuthorityType.MintTokens, newAuthority: null }));
}

/** Share state for a PORT, or null for PORTs created before share support (no collection / no escrow). */
export async function fetchPortShares(umi: Umi, port: Pick<PortAccount, "owner" | "collection">): Promise<PortShares | null> {
  if (!port.collection) return null;
  const escrow = findEscrow(umi, port.collection);
  const e = await safeFetchEscrowV1(umi, escrow);
  if (!e) return null;
  const [collection, mint, escrowTok] = await Promise.all([
    fetchCollectionV1(umi, port.collection),
    safeFetchMint(umi, e.token),
    safeFetchToken(umi, shareAta(umi, e.token, escrow)),
  ]);
  return {
    collection: port.collection, escrow, mint: e.token, decimals: mint?.decimals ?? SHARE_DECIMALS, supply: e.amount,
    escrowBalance: escrowTok?.amount ?? 0n, tokenized: port.owner === escrow, sealed: collection.updateAuthority === SEALED_AUTHORITY,
  };
}

async function sharesFor(umi: Umi, asset: PublicKey) {
  const port = await fetchPort(umi, asset);
  const s = await fetchPortShares(umi, port);
  if (!s) throw new PortError("NOT_TOKENIZABLE", "This PORT was created without a share escrow.");
  return { port, s };
}

/**
 * The hybrid program only requires `authority` to sign when it is the escrow authority (for
 * metadata rerolls, which this escrow never does). Passing the escrow PDA keeps swaps
 * permissionless; the generated client types it as a Signer, but a plain key is sent unsigned.
 */
const unsigned = (k: PublicKey) => k as unknown as Signer;

type SwapAccounts = { owner: Signer; authority: Signer; escrow: PublicKey; asset: PublicKey; collection: PublicKey; token: PublicKey; feeProjectAccount: PublicKey; feeSolAccount: PublicKey };

/** Sends a swap; on InvalidConstantFeeWallet (0x1773) retries once with the wallet the program logged. */
async function swap(umi: Umi, build: (a: SwapAccounts) => TransactionBuilder, a: Omit<SwapAccounts, "feeSolAccount">): Promise<SentTx> {
  try {
    return await send(umi, build({ ...a, feeSolAccount: HYBRID_FEE_WALLET }));
  } catch (e) {
    const err = e as PortError;
    const logs = err.logs ?? [];
    const i = logs.findIndex((l) => /InvalidConstantFeeWallet/.test(l));
    const right = i >= 0 ? logs.slice(i).find((l, j) => j > 0 && /Right:/.test(logs[i + j - 1] ?? "")) : undefined;
    const expected = right?.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/)?.[0];
    if (!expected) throw e;
    return send(umi, build({ ...a, feeSolAccount: publicKey(expected) }));
  }
}

/** Owner locks the PORT in its hybrid escrow and receives the full share supply (releaseV1). */
export async function tokenizePort(umi: Umi, asset: PublicKey): Promise<SentTx> {
  const { port, s } = await sharesFor(umi, asset);
  if (s.tokenized) throw new PortError("ALREADY_TOKENIZED", "This PORT is already held by its share escrow.");
  if (port.owner !== umi.identity.publicKey) throw new PortError("NOT_AUTHORIZED", "Only the current owner can tokenize this PORT.");
  if (s.escrowBalance < s.supply) throw new PortError("INSUFFICIENT_SHARES", "The escrow does not hold the full share supply.");
  const e = await safeFetchEscrowV1(umi, s.escrow);
  return swap(umi, (a) => releaseV1(umi, a), { owner: umi.identity, authority: unsigned(s.escrow), escrow: s.escrow, asset, collection: s.collection, token: s.mint, feeProjectAccount: e!.feeLocation });
}

/** A holder of the full supply pays it back into escrow and takes the PORT (captureV1). */
export async function redeemPort(umi: Umi, asset: PublicKey): Promise<SentTx> {
  const { s } = await sharesFor(umi, asset);
  if (!s.tokenized) throw new PortError("NOT_TOKENIZED", "This PORT is not in its share escrow.");
  const held = await shareBalance(umi, s.mint, umi.identity.publicKey);
  if (held < s.supply) throw new PortError("INSUFFICIENT_SHARES", `Redeeming needs the full supply (${s.supply}); this wallet holds ${held}.`);
  const e = await safeFetchEscrowV1(umi, s.escrow);
  return swap(umi, (a) => captureV1(umi, a), { owner: umi.identity, authority: unsigned(s.escrow), escrow: s.escrow, asset, collection: s.collection, token: s.mint, feeProjectAccount: e!.feeLocation });
}

export async function shareBalance(umi: Umi, mint: PublicKey, owner: PublicKey): Promise<bigint> {
  return (await safeFetchToken(umi, shareAta(umi, mint, owner)))?.amount ?? 0n;
}

/** Plain SPL transfer of shares from the connected wallet; creates the recipient's ATA if needed. */
export async function transferShares(umi: Umi, mint: PublicKey, to: PublicKey, amount: bigint): Promise<SentTx> {
  const dest = shareAta(umi, mint, to);
  return send(
    umi,
    transactionBuilder()
      .add(createIdempotentAssociatedToken(umi, { mint, owner: to, ata: dest }))
      .add(transferTokens(umi, { source: shareAta(umi, mint, umi.identity.publicKey), destination: dest, amount })),
  );
}
