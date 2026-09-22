"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createSignerFromKeypair, generateSigner, publicKey, type Instruction, type Signer, type Umi } from "@metaplex-foundation/umi";
import { base64 } from "@metaplex-foundation/umi/serializers";
import {
  createPort, delegateExecution, depositToPort, fetchLookupTables, guardedExecute, makeUmi, revokeExecution, transferPort, fetchPort,
  BASE_PROGRAM_ALLOWLIST, type SentTx,
} from "@port/port-sdk";
import type { PortActivity } from "@port/shared";
import { DEMO_PORT_NAME, DEMO_STRATEGY } from "@port/integrations/demo";
import type { EnvDto, InstructionDto, TradeDto } from "./dto";

const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// --- API ------------------------------------------------------------------------------------

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { code: data.code });
  return data as T;
}

export function useEnv() {
  const [env, setEnv] = useState<(EnvDto & { demo: { asset: string } | null }) | null>(null);
  useEffect(() => void api<EnvDto & { demo: { asset: string } | null }>("/api/env").then(setEnv).catch(() => {}), []);
  return env;
}

// --- Burner wallets ---------------------------------------------------------------------------
// Fork/localnet demo wallets are generated and kept in this browser only; keys never touch the server.

export type Wallet = { label: "Wallet A" | "Wallet B"; signer: Signer };
const KEY = "port.burners.v1";
const LABELS = ["Wallet A", "Wallet B"] as const;

function loadWallets(): Wallet[] {
  const umi = makeUmi("http://127.0.0.1:1");
  let stored: number[][] = [];
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {}
  const wallets = LABELS.map((label, i) => {
    const secret = stored[i];
    const signer = secret ? createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(new Uint8Array(secret))) : generateSigner(umi);
    return { label, signer };
  });
  try {
    localStorage.setItem(KEY, JSON.stringify(wallets.map((w) => Array.from(w.signer.secretKey))));
  } catch {}
  return wallets;
}

// Browser-only state read through useSyncExternalStore: stable snapshots, empty on the server.
let walletCache: Wallet[] | null = null;
let activeCache: 0 | 1 = 0;
const listeners = new Set<() => void>();
const EMPTY: Wallet[] = [];
const subscribe = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));
function walletSnapshot(): Wallet[] {
  if (!walletCache) {
    walletCache = loadWallets();
    try {
      activeCache = localStorage.getItem("port.activeWallet") === "1" ? 1 : 0;
    } catch {}
  }
  return walletCache;
}

export function useWallets() {
  const wallets = useSyncExternalStore(subscribe, walletSnapshot, () => EMPTY);
  const active = useSyncExternalStore(subscribe, () => (walletSnapshot(), activeCache), () => 0 as const);
  const setActive = useCallback((i: 0 | 1) => {
    activeCache = i;
    try {
      localStorage.setItem("port.activeWallet", String(i));
    } catch {}
    listeners.forEach((l) => l());
  }, []);
  return { wallets, active: wallets[active], activeIndex: active, setActive };
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
