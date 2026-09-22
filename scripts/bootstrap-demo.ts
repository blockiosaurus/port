/**
 * One-command demo on the local mainnet fork (pnpm demo:fork must be running):
 *   Wallet A creates "AI Private Markets Fund #001", deposits USDC, buys OpenAI PreStocks
 *   through Core Execute, delegates to the agent executive, the agent completes the mandate,
 *   A transfers the PORT to Wallet B, and B trades. Writes .demo/state.json.
 *
 * Use a freshly started fork: Jupiter quotes mainnet pools, while trades here move the cloned
 * pools, so repeated buys in the same pool on one fork trip the on-chain min-out protection.
 *
 * Wallet keys are throwaway fork burners stored under .keys/ (gitignored).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createSignerFromKeypair, generateSigner, publicKey, sol, transactionBuilder, type Signer } from "@metaplex-foundation/umi";
import { createIdempotentAssociatedToken, findAssociatedTokenPda, transferTokensChecked } from "@metaplex-foundation/mpl-toolbox";
import { fromBaseUnits, usdE8 } from "@port/shared";
import { createPort, delegateExecution, depositToPort, ensureExecutive, makeUmi, send, transferPort, fetchPort } from "@port/port-sdk";
import {
  ActivityStore, DEMO_PORT_NAME, DEMO_STRATEGY, executeEvaluated, executeRebalance, loadSnapshot, proposeTrade, USDC_MAINNET, type AgentContext,
} from "@port/integrations";
import { assertLocalRpc, FORK_RPC, waitForRpc } from "./lib/fork";

const RPC = assertLocalRpc(process.env.FORK_RPC_URL ?? FORK_RPC);
const DEPOSIT_USDC = BigInt(process.env.DEMO_DEPOSIT_USDC ?? "2500") * 1_000_000n;
const activity = new ActivityStore(".demo/activity.json");

async function key(name: string, create = false): Promise<Signer> {
  const path = `.keys/${name}.json`;
  const umi = makeUmi(RPC);
  if (!existsSync(path)) {
    if (!create) throw new Error(`${path} missing; run pnpm demo:fork:prepare`);
    await writeFile(path, JSON.stringify(Array.from(generateSigner(umi).secretKey)), { mode: 0o600 });
  }
  return createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(new Uint8Array(JSON.parse(await readFile(path, "utf8")))));
}

const ctxFor = (s: Signer): AgentContext => ({
  umi: makeUmi(RPC, s), rpcUrl: RPC, cluster: "fork", activity,
  devPriceFallback: !process.env.PYTH_API_KEY && process.env.DEV_PRICE_FALLBACK === "1",
});
const log = (step: string, detail = "") => console.log(`\n▸ ${step}${detail ? `\n  ${detail}` : ""}`);

await waitForRpc(RPC, 30_000);
await mkdir(".demo", { recursive: true });
if (existsSync(".demo/activity.json")) await writeFile(".demo/activity.json", "[]");
const treasury = await key("treasury");
const executive = await key("executive");
const A = await key("wallet-a", true);
const B = await key("wallet-b", true);
const base = makeUmi(RPC);
for (const s of [treasury, executive, A, B]) await base.rpc.airdrop(s.publicKey, sol(20));

log("Faucet: treasury → Wallet A", `${fromBaseUnits(DEPOSIT_USDC, 6)} USDC (fork)`);
const tu = makeUmi(RPC, treasury);
const usdc = publicKey(USDC_MAINNET);
const ataA = findAssociatedTokenPda(tu, { mint: usdc, owner: A.publicKey })[0];
await send(tu, transactionBuilder()
  .add(createIdempotentAssociatedToken(tu, { mint: usdc, owner: A.publicKey, ata: ataA }))
  .add(transferTokensChecked(tu, { source: findAssociatedTokenPda(tu, { mint: usdc, owner: treasury.publicKey })[0], destination: ataA, mint: usdc, amount: DEPOSIT_USDC, decimals: 6 })));

const ua = makeUmi(RPC, A);
log("Wallet A creates the PORT");
const created = await createPort(ua, { name: DEMO_PORT_NAME, uri: "https://port.markets/fund-001.json", strategy: DEMO_STRATEGY, agentRegistrationUri: "https://port.markets/agent-001.json" });
const asset = created.asset;
await activity.append({ portAsset: asset, actor: A.publicKey, authority: "owner", action: "create", status: "confirmed", signature: created.signature, details: { name: DEMO_PORT_NAME, assetSigner: created.signer } });
console.log(`  asset ${asset}\n  Asset Signer ${created.signer}\n  sig ${created.signature}`);

log("Wallet A deposits USDC into the Asset Signer");
const port = await fetchPort(base, asset);
const dep = await depositToPort(ua, port, usdc, DEPOSIT_USDC);
await activity.append({ portAsset: asset, actor: A.publicKey, authority: "owner", action: "deposit", status: "confirmed", signature: dep.signature, details: { symbol: "USDC", amount: DEPOSIT_USDC.toString() } });

const summarize = (r: Awaited<ReturnType<typeof executeRebalance>>) =>
  r.results.map((x) => `${x.activity.status.padEnd(9)} ${x.trade.side} ${x.trade.symbol} ${usdE8(x.trade.notionalE8)}${x.activity.signature ? ` ${x.activity.signature.slice(0, 16)}…` : ""}${x.decision.allowed ? "" : ` BLOCKED: ${x.decision.checks.filter((c) => !c.passed).map((c) => c.code).join(",")}`}`).join("\n  ") || "(no trades)";

log("Wallet A (owner) buys OpenAI PreStocks through Core Execute");
const own = await proposeTrade(ctxFor(A), asset, { side: "buy", symbol: "OPENAI", notionalUsd: ((DEPOSIT_USDC * 28n) / 100n / 1_000_000n).toString() });
for (const w of own.snapshot.warnings) console.log(`  ⚠ ${w}`);
const ownRes = await executeEvaluated(ctxFor(A), asset, own.trade, "owner");
console.log(`  ${ownRes.status} buy OPENAI ${usdE8(own.trade.trade.notionalE8)} ${ownRes.signature ?? summarizeBlocked(own.trade.decision)}`);

log("Agent executive registers; Wallet A delegates execution");
const ue = makeUmi(RPC, executive);
const reg = await ensureExecutive(ue);
const del = await delegateExecution(ua, asset, executive.publicKey);
await activity.append({ portAsset: asset, actor: A.publicKey, authority: "owner", action: "delegate", status: "confirmed", signature: del.signature, details: { executive: executive.publicKey, registered: reg?.signature ?? "already" } });

log("Agent completes the mandate under delegated Core Execute");
const r2 = await executeRebalance(ctxFor(executive), asset, "delegate");
console.log(`  ${r2.proposal.plan.rationale}\n  ${summarize(r2)}`);

const before = await loadSnapshot(ctxFor(A), asset);
log("Wallet A transfers the PORT to Wallet B");
const xfer = await transferPort(ua, asset, B.publicKey);
await activity.append({ portAsset: asset, actor: A.publicKey, authority: "owner", action: "transfer", status: "confirmed", signature: xfer.signature, details: { from: A.publicKey, to: B.publicKey, navE8: before.valuation.navE8.toString() } });
const after = await loadSnapshot(ctxFor(B), asset);
console.log(`  owner ${before.port.owner} → ${after.port.owner}`);
console.log(`  Asset Signer unchanged: ${before.port.signer === after.port.signer} (${after.port.signer})`);
console.log(`  balances unchanged: ${JSON.stringify(before.balances.map((b) => b.amount.toString())) === JSON.stringify(after.balances.map((b) => b.amount.toString()))}`);
console.log(`  delegates inherited by B: ${after.delegates.map((d) => d.executiveAuthority).join(", ") || "none"}`);

log("Wallet B (new owner) trades");
const p = await proposeTrade(ctxFor(B), asset, { side: "sell", symbol: "ANDURIL", notionalUsd: "50" });
const b = await executeEvaluated(ctxFor(B), asset, p.trade, "owner");
console.log(`  ${b.status} sell ANDURIL $50 ${b.signature ?? summarizeBlocked(p.trade.decision)}`);

await writeFile(".demo/state.json", JSON.stringify({
  rpcUrl: RPC, cluster: "fork", asset, assetSigner: created.signer, walletA: A.publicKey, walletB: B.publicKey, executive: executive.publicKey,
  signatures: { create: created.signature, deposit: dep.signature, delegate: del.signature, transfer: xfer.signature, newOwnerTrade: b.signature },
  createdAt: new Date().toISOString(),
}, null, 2));
log("Done", "State written to .demo/state.json. Verify with: pnpm demo:verify");

function summarizeBlocked(d: { checks: Array<{ code: string; passed: boolean }> }) {
  return `BLOCKED: ${d.checks.filter((c) => !c.passed).map((c) => c.code).join(",")}`;
}
