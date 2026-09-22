import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createNoopSigner, createSignerFromKeypair, publicKey, type Signer } from "@metaplex-foundation/umi";
import { ensureExecutive, makeUmi } from "@port/port-sdk";
import { sol } from "@metaplex-foundation/umi";
import { ActivityStore, type AgentContext } from "@port/integrations";

/** Repo root (the web app runs from apps/web). Keys and demo state live there, gitignored. */
export const ROOT = join(process.cwd(), "../..");
export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:28899";
export const CLUSTER = (process.env.PORT_CLUSTER ?? "fork") as "fork" | "localnet" | "devnet" | "mainnet-beta";
export const IS_LOCAL = CLUSTER === "fork" || CLUSTER === "localnet";
export const DEV_PRICE_FALLBACK = IS_LOCAL && !process.env.PYTH_API_KEY && process.env.DEV_PRICE_FALLBACK === "1";

export const activity = new ActivityStore(join(ROOT, ".demo/activity.json"));

function loadKey(name: string): Signer | null {
  const path = join(ROOT, ".keys", `${name}.json`);
  if (!existsSync(path)) return null;
  const umi = makeUmi(RPC_URL);
  return createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, "utf8")))));
}

/** The agent executive's key never leaves the server. */
export const executive = () => loadKey(process.env.EXECUTIVE_KEY_NAME ?? "executive");
export const treasury = () => (IS_LOCAL ? loadKey("treasury") : null);

export function agentContext(signer: Signer): AgentContext {
  const ex = executive();
  return {
    umi: makeUmi(RPC_URL, signer),
    rpcUrl: RPC_URL,
    cluster: CLUSTER,
    activity,
    devPriceFallback: DEV_PRICE_FALLBACK,
    knownExecutives: ex ? [ex.publicKey] : [],
  };
}

/** Read-only context acting "as" a public key (for quoting owner trades the browser will sign). */
export const readContext = (as: string) => agentContext(createNoopSigner(publicKey(as)));

export function demoState(): Record<string, unknown> | null {
  const p = join(ROOT, ".demo/state.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

/** JSON with bigint → string. */
export function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? Object.fromEntries(v) : v)), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export function errorJson(e: unknown, status = 400) {
  const err = e as { message?: string; code?: string };
  return json({ error: err.message ?? String(e), code: err.code }, { status });
}

export const env = () => ({
  cluster: CLUSTER,
  rpcUrl: RPC_URL,
  pythConfigured: Boolean(process.env.PYTH_API_KEY),
  devPriceFallback: DEV_PRICE_FALLBACK,
  executive: executive()?.publicKey ?? null,
  faucet: Boolean(treasury()),
});

let executiveReady: Promise<void> | null = null;
let executiveCheckedAt = 0;
/**
 * The agent must hold an MPL Agent executive profile before an owner can delegate to it.
 * On local clusters we fund and register it on first use; on live clusters run the setup script.
 */
export function ensureAgentExecutive(): Promise<void> {
  // Re-check periodically: a fork reset wipes the profile while this server keeps running.
  if (Date.now() - executiveCheckedAt > 60_000) executiveReady = null;
  executiveReady ??= (async () => {
    executiveCheckedAt = Date.now();
    const ex = executive();
    if (!ex) return;
    const umi = makeUmi(RPC_URL, ex);
    if (IS_LOCAL && (await umi.rpc.getBalance(ex.publicKey)).basisPoints < 1_000_000_000n) await umi.rpc.airdrop(ex.publicKey, sol(10));
    await ensureExecutive(umi);
  })().catch((e) => {
    executiveReady = null;
    throw e;
  });
  return executiveReady;
}
