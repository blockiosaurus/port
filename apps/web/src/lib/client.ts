"use client";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { createSignerFromKeypair, generateSigner, publicKey, type Instruction, type KeypairSigner, type Umi } from "@metaplex-foundation/umi";
import { base64 } from "@metaplex-foundation/umi/serializers";
import { useWallet } from "@solana/wallet-adapter-react";
import { createSignerFromWalletAdapter } from "@metaplex-foundation/umi-signer-wallet-adapters";
import {
  createPort, delegateExecution, depositToPort, fetchLookupTables, guardedExecute, makeUmi, revokeExecution, transferPort, fetchPort,
  BASE_PROGRAM_ALLOWLIST, type SentTx,
} from "@port/port-sdk";
import type { PortActivity } from "@port/shared";
import { DEMO_PORT_NAME, DEMO_STRATEGY } from "@port/integrations/demo";
import type { EnvDto, InstructionDto, TradeDto } from "./dto";
import { burnerId, composeWallets, EXTERNAL_ID, type Wallet } from "./wallets-model";
import { useEnvContext } from "./wallet";

export type { Wallet } from "./wallets-model";

const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// --- API ------------------------------------------------------------------------------------

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { code: data.code });
  return data as T;
}

/** Environment, fetched once by `Providers` in lib/wallet.tsx. Null until loaded. */
export const useEnv = useEnvContext;

// --- Burner wallets ---------------------------------------------------------------------------
// Fork/localnet demo wallets are generated and kept in this browser only; keys never touch the server.

type Burner = Wallet & { kind: "burner"; signer: KeypairSigner };
const KEY = "port.burners.v1";
const ACTIVE_KEY = "port.activeWallet";
const LABELS = ["Wallet A", "Wallet B"] as const;

function loadBurners(): Burner[] {
  const umi = makeUmi("http://127.0.0.1:1");
  let stored: number[][] = [];
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {}
  const wallets = LABELS.map((label, i): Burner => {
    const secret = stored[i];
    const signer = secret ? createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(new Uint8Array(secret))) : generateSigner(umi);
    return { id: burnerId(i), label, kind: "burner", signer };
  });
  try {
    localStorage.setItem(KEY, JSON.stringify(wallets.map((w) => Array.from(w.signer.secretKey))));
  } catch {}
  return wallets;
}

// Browser-only state read through useSyncExternalStore: stable snapshots, empty on the server.
let burnerCache: Burner[] | null = null;
let activeCache: string | null = null;
const listeners = new Set<() => void>();
const EMPTY: Burner[] = [];
const subscribe = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));
function burnerSnapshot(): Burner[] {
  if (!burnerCache) {
    burnerCache = loadBurners();
    try {
      const raw = localStorage.getItem(ACTIVE_KEY);
      activeCache = raw === "0" || raw === "1" ? burnerId(Number(raw)) : raw; // pre-adapter versions stored an index
    } catch {}
  }
  return burnerCache;
}
function setActiveId(id: string) {
  activeCache = id;
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {}
  listeners.forEach((l) => l());
}

/**
 * Every identity this browser can sign with: the connected Wallet Standard wallet (if any) plus,
 * on fork/localnet only, the two burners. `active` is what the pages act as.
 */
export function useWallets() {
  const env = useEnvContext();
  const local = env?.cluster === "fork" || env?.cluster === "localnet";
  const burners = useSyncExternalStore(subscribe, burnerSnapshot, () => EMPTY);
  const activeId = useSyncExternalStore(subscribe, () => (burnerSnapshot(), activeCache), () => null);

  const adapter = useWallet();
  const externalKey = adapter.connected && adapter.publicKey ? adapter.publicKey.toBase58() : null;
  const externalName = adapter.wallet?.adapter.name ?? "Wallet";
  const external = useMemo<Wallet | null>(
    () => (externalKey ? { id: EXTERNAL_ID, label: externalName, kind: "external", signer: createSignerFromWalletAdapter(adapter) } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the adapter context is stable per connection; re-create only when the key changes
    [externalKey, externalName],
  );
  // A wallet that just connected becomes the acting identity.
  useEffect(() => {
    if (externalKey) setActiveId(EXTERNAL_ID);
  }, [externalKey]);

  const { wallets, active } = useMemo(() => composeWallets({ burners, external, local, activeId }), [burners, external, local, activeId]);
  const setActive = useCallback((id: string) => setActiveId(id), []);
  return { wallets, active, setActive };
}

export const umiFor = (rpcUrl: string, w: Wallet) => makeUmi(rpcUrl, w.signer);

// --- Signed actions ---------------------------------------------------------------------------

async function record(asset: string, w: Wallet, action: PortActivity["action"], tx: SentTx, extra: Partial<PortActivity> = {}) {
  await api("/api/activity", { portAsset: asset, actor: w.signer.publicKey, authority: "owner", action, signature: tx.signature, ...extra }).catch(() => {});
  return tx;
}

export async function actionCreate(umi: Umi, w: Wallet) {
  const res = await createPort(umi, {
    name: DEMO_PORT_NAME,
    uri: "https://port.markets/fund-001.json",
    strategy: DEMO_STRATEGY,
    agentRegistrationUri: "https://port.markets/agent-001.json",
  });
  await record(res.asset, w, "create", res, { details: { assetSigner: res.signer, setup: res.setupSignature } });
  return res;
}

export async function actionDeposit(umi: Umi, w: Wallet, asset: string, usdc: number) {
  const port = await fetchPort(umi, publicKey(asset));
  const tx = await depositToPort(umi, port, publicKey(USDC), BigInt(usdc) * 1_000_000n);
  return record(asset, w, "deposit", tx, { details: { symbol: "USDC", amount: String(BigInt(usdc) * 1_000_000n) } });
}

const toIx = (d: InstructionDto): Instruction => ({
  programId: publicKey(d.programId),
  keys: d.keys.map((k) => ({ ...k, pubkey: publicKey(k.pubkey) })),
  data: base64.serialize(d.data),
});

/** Wraps server-prepared (and server-validated) instructions in Core Execute, re-checking the allowlist here. */
export async function actionTrade(umi: Umi, w: Wallet, asset: string, t: TradeDto) {
  if (!t.decision.allowed || !t.prepared) throw new Error("Trade was not approved by the risk policy");
  const tx = await guardedExecute(umi, {
    asset: publicKey(asset),
    instructions: t.prepared.instructions.map(toIx),
    allowedPrograms: [...BASE_PROGRAM_ALLOWLIST, JUPITER],
    as: { authority: "owner" },
    computeUnits: 1_000_000,
    addressLookupTables: await fetchLookupTables(umi, t.prepared.addressLookupTables),
  });
  return record(asset, w, "trade", tx, {
    rationale: t.trade.reasons.join("; "),
    riskDecision: t.decision,
    details: { side: t.trade.side, symbol: t.trade.symbol, notionalE8: t.trade.notionalE8, amountIn: t.trade.amountIn, route: t.prepared.routeLabels },
  });
}

export async function actionDelegate(umi: Umi, w: Wallet, asset: string, executive: string) {
  return record(asset, w, "delegate", await delegateExecution(umi, publicKey(asset), publicKey(executive)), { details: { executive } });
}
export async function actionRevoke(umi: Umi, w: Wallet, asset: string, executive: string) {
  return record(asset, w, "revoke", await revokeExecution(umi, publicKey(asset), publicKey(executive)), { details: { executive } });
}
export async function actionTransfer(umi: Umi, w: Wallet, asset: string, to: string, snapshot: unknown) {
  return record(asset, w, "transfer", await transferPort(umi, publicKey(asset), publicKey(to)), { details: { from: w.signer.publicKey, to, before: snapshot } });
}

export async function faucet(env: EnvDto, w: Wallet, usdc = 5000) {
  if (!env.faucet) throw new Error("Faucet unavailable on this cluster");
  return api<{ signature: string }>("/api/faucet", { owner: w.signer.publicKey, usdc });
}

// --- Remembered PORTs (per browser convenience) ---------------------------------------------

export function rememberedPorts(): string[] {
  try {
    return JSON.parse(localStorage.getItem("port.ports") ?? "[]");
  } catch {
    return [];
  }
}

let portsCache: string[] | null = null;
const NO_PORTS: string[] = [];
export function useRememberedPorts(): string[] {
  return useSyncExternalStore(subscribe, () => (portsCache ??= rememberedPorts()), () => NO_PORTS);
}
export function rememberPort(asset: string) {
  try {
    localStorage.setItem("port.ports", JSON.stringify([asset, ...rememberedPorts().filter((a) => a !== asset)].slice(0, 12)));
    portsCache = null;
  } catch {}
}
