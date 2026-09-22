import { publicKey, transactionBuilder, type Instruction, type PublicKey, type Umi } from "@metaplex-foundation/umi";
import { execute } from "@metaplex-foundation/mpl-core";
import { fetchAddressLookupTable, setComputeUnitLimit } from "@metaplex-foundation/mpl-toolbox";
import type { AddressLookupTableInput } from "@metaplex-foundation/umi";
import {
  fetchAllExecutionDelegateRecordV1,
  findExecutionDelegateRecordV1Pda,
  findExecutiveProfileV1Pda,
  getExecutionDelegateRecordV1GpaBuilder,
  delegateExecutionV1,
  findAgentIdentityV2Pda,
  registerExecutiveV1,
  revokeExecutionV1,
  safeFetchExecutionDelegateRecordV1,
  safeFetchExecutiveProfileV1,
} from "@metaplex-foundation/mpl-agent-registry";
import { PortError } from "./errors";
import { fetchPort, findPortSigner, send, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type SentTx } from "./port";

export const SYSTEM_PROGRAM = publicKey("11111111111111111111111111111111");
export const ATA_PROGRAM = publicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Programs the Asset Signer may invoke for basic custody. Trade adapters extend this list explicitly. */
export const BASE_PROGRAM_ALLOWLIST: readonly string[] = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ATA_PROGRAM, SYSTEM_PROGRAM];

export type ExecuteAs =
  | { authority: "owner" }
  | { authority: "delegate"; executiveAuthority?: PublicKey };

export type GuardedExecuteInput = {
  asset: PublicKey;
  instructions: Instruction[];
  allowedPrograms: readonly string[];
  as: ExecuteAs;
  computeUnits?: number;
  addressLookupTables?: AddressLookupTableInput[];
};

export async function fetchLookupTables(umi: Umi, addresses: readonly string[]): Promise<AddressLookupTableInput[]> {
  return Promise.all(addresses.map(async (a) => {
    const t = await fetchAddressLookupTable(umi, publicKey(a));
    return { publicKey: t.publicKey, addresses: t.addresses };
  }));
}

/**
 * Validates inner instructions, then wraps each in Core Execute so the Asset Signer signs by CPI.
 * Checks: every program allowlisted; the Asset Signer is the only inner signer other than
 * the caller (who may pay fees); delegate calls carry the delegate record.
 */
export function buildGuardedExecute(umi: Umi, input: GuardedExecuteInput) {
  const signer = findPortSigner(umi, input.asset);
  const caller = umi.identity.publicKey;
  for (const ix of input.instructions) {
    if (!input.allowedPrograms.includes(ix.programId))
      throw new PortError("PROGRAM_NOT_ALLOWED", `Program ${ix.programId} is not on the PORT allowlist.`);
    for (const k of ix.keys)
      if (k.isSigner && k.pubkey !== signer && k.pubkey !== caller)
        throw new PortError("UNEXPECTED_SIGNER", `Inner instruction requires unexpected signer ${k.pubkey}.`);
  }
  let executionDelegateRecord: PublicKey | undefined;
  if (input.as.authority === "delegate") {
    const profile = findExecutiveProfileV1Pda(umi, { authority: input.as.executiveAuthority ?? caller })[0];
    executionDelegateRecord = findExecutionDelegateRecordV1Pda(umi, { executiveProfile: profile, agentAsset: input.asset })[0];
  }
  return transactionBuilder()
    .add(setComputeUnitLimit(umi, { units: input.computeUnits ?? 400_000 }))
    .add(
      execute(umi, {
        asset: { publicKey: input.asset },
        instructions: input.instructions,
        ...(executionDelegateRecord ? { executionDelegateRecord } : {}),
      }),
    )
    .setAddressLookupTables(input.addressLookupTables ?? []);
}

export async function guardedExecute(umi: Umi, input: GuardedExecuteInput): Promise<SentTx> {
  if (input.as.authority === "owner") {
    const port = await fetchPort(umi, input.asset);
    if (port.owner !== umi.identity.publicKey) throw new PortError("NOT_AUTHORIZED", "Connected wallet does not own this PORT.");
  } else {
    const d = await fetchDelegate(umi, input.asset, umi.identity.publicKey);
    if (!d) throw new PortError("NOT_DELEGATED", "Connected wallet has no execution delegation for this PORT.");
  }
  return send(umi, buildGuardedExecute(umi, input));
}

// --- Delegation (MPL Agent Tools) -------------------------------------------------------

export const findExecutiveProfile = (umi: Umi, authority: PublicKey) => findExecutiveProfileV1Pda(umi, { authority })[0];
export const findDelegateRecord = (umi: Umi, asset: PublicKey, executiveAuthority: PublicKey) =>
  findExecutionDelegateRecordV1Pda(umi, { executiveProfile: findExecutiveProfile(umi, executiveAuthority), agentAsset: asset })[0];

/** Registers the caller as an executive (idempotent). */
export async function ensureExecutive(umi: Umi): Promise<SentTx | null> {
  const profile = findExecutiveProfile(umi, umi.identity.publicKey);
  if (await safeFetchExecutiveProfileV1(umi, profile)) return null;
  return send(umi, registerExecutiveV1(umi, {}));
}

/** Owner grants execution to an executive. */
export async function delegateExecution(umi: Umi, asset: PublicKey, executiveAuthority: PublicKey): Promise<SentTx> {
  const profile = findExecutiveProfile(umi, executiveAuthority);
  if (!(await safeFetchExecutiveProfileV1(umi, profile)))
    throw new PortError("NOT_DELEGATED", "Executive has not registered a profile yet.");
  return send(
    umi,
    delegateExecutionV1(umi, { executiveProfile: profile, agentAsset: asset, agentIdentity: findAgentIdentityV2Pda(umi, { asset })[0] }),
  );
}

/** Owner (or the executive itself) revokes; rent refunds to the caller. */
export async function revokeExecution(umi: Umi, asset: PublicKey, executiveAuthority: PublicKey): Promise<SentTx> {
  const record = findDelegateRecord(umi, asset, executiveAuthority);
  if (!(await safeFetchExecutionDelegateRecordV1(umi, record))) throw new PortError("NOT_DELEGATED", "No active delegation to revoke.");
  return send(umi, revokeExecutionV1(umi, { executionDelegateRecord: record, agentAsset: asset, destination: umi.identity.publicKey }));
}

/** Delegate records do not store who granted them; a new owner inherits every live record. */
export type DelegateInfo = { record: string; executiveProfile: string; executiveAuthority: string };

export async function fetchDelegate(umi: Umi, asset: PublicKey, executiveAuthority: PublicKey): Promise<DelegateInfo | null> {
  const record = findDelegateRecord(umi, asset, executiveAuthority);
  const r = await safeFetchExecutionDelegateRecordV1(umi, record);
  if (!r) return null;
  return { record, executiveProfile: r.executiveProfile, executiveAuthority: r.authority };
}

/**
 * All live delegate records for a PORT. Delegations persist across Core transfers, so a new
 * owner must review this list. Uses getProgramAccounts; falls back to known executives when
 * the RPC disallows GPA.
 */
export async function listDelegates(umi: Umi, asset: PublicKey, knownExecutives: PublicKey[] = []): Promise<DelegateInfo[]> {
  try {
    const recs = await getExecutionDelegateRecordV1GpaBuilder(umi).whereField("agentAsset", asset).getDeserialized();
    return recs.map((r) => ({ record: r.publicKey, executiveProfile: r.executiveProfile, executiveAuthority: r.authority }));
  } catch {
    const records = knownExecutives.map((e) => findDelegateRecord(umi, asset, e));
    const found = await fetchAllExecutionDelegateRecordV1(umi, records).catch(() => []);
    return found.map((r) => ({ record: r.publicKey, executiveProfile: r.executiveProfile, executiveAuthority: r.authority }));
  }
}
