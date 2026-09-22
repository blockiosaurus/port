import { publicKey, type Instruction, type Umi } from "@metaplex-foundation/umi";
import { fromBaseUnits, toBaseUnits, type Cluster, type PortActivity, type PriceSnapshot, type RiskDecision } from "@port/shared";
import {
  ataFor, BASE_PROGRAM_ALLOWLIST, fetchLookupTables, fetchMintInfo, fetchPort, fetchPortBalances, guardedExecute, listDelegates,
  type Balance, type DelegateInfo, type PortAccount,
} from "@port/port-sdk";
import { evaluateTrade, planRebalance, unitsForNotional, valuePortfolio, type PlannedTrade, type RebalancePlan, type Valuation } from "@port/risk-engine";
import type { ActivityStore } from "./activity";
import { JUPITER_PROGRAM, JupiterTradeAdapter, type PreparedSwap } from "./jupiter";
import { buildPriceSnapshots, PythHermesClient } from "./pricing";
import { fetchToken2022Profile, PRESTOCK_MINTS, type Token2022Profile } from "./prestocks";

export const TRADE_PROGRAM_ALLOWLIST: readonly string[] = [...BASE_PROGRAM_ALLOWLIST, JUPITER_PROGRAM];

export type AgentContext = {
  umi: Umi;
  rpcUrl: string;
  cluster: Cluster | "fork";
  activity: ActivityStore;
  jupiter?: JupiterTradeAdapter;
  pyth?: PythHermesClient;
  /** Executive public keys to check when the RPC blocks getProgramAccounts. */
  knownExecutives?: string[];
  /** See PricingSources.devFallback; ignored unless cluster is fork or localnet. */
  devPriceFallback?: boolean;
};

export type PortSnapshot = {
  port: PortAccount;
  balances: Balance[];
  prices: Map<string, PriceSnapshot>;
  valuation: Valuation;
  delegates: DelegateInfo[];
  profiles: Map<string, Token2022Profile>;
  warnings: string[];
};

const profileCache = new Map<string, { at: number; p: Token2022Profile }>();
async function profilesFor(rpcUrl: string, mints: string[]): Promise<Map<string, Token2022Profile>> {
  const out = new Map<string, Token2022Profile>();
  await Promise.all(
    mints.filter((m) => PRESTOCK_MINTS.includes(m)).map(async (m) => {
      const hit = profileCache.get(`${rpcUrl}:${m}`);
      if (hit && Date.now() - hit.at < 60_000) return out.set(m, hit.p);
      const p = await fetchToken2022Profile(rpcUrl, m);
      profileCache.set(`${rpcUrl}:${m}`, { at: Date.now(), p });
      out.set(m, p);
    }),
  );
  return out;
}

export async function loadSnapshot(ctx: AgentContext, asset: string): Promise<PortSnapshot> {
  const port = await fetchPort(ctx.umi, publicKey(asset));
  const [balances, profiles, delegates] = await Promise.all([
    fetchPortBalances(ctx.umi, port),
    profilesFor(ctx.rpcUrl, port.strategy.targets.map((t) => t.mint)),
    listDelegates(ctx.umi, port.asset, (ctx.knownExecutives ?? []).map((k) => publicKey(k))),
  ]);
  const { prices, warnings } = await buildPriceSnapshots(port.strategy, {
    pyth: ctx.pyth ?? new PythHermesClient(),
    jupiter: ctx.jupiter ?? new JupiterTradeAdapter(),
    profiles,
    devFallback: ctx.devPriceFallback === true && (ctx.cluster === "fork" || ctx.cluster === "localnet"),
  });
  const valuation = valuePortfolio(port.strategy, balances, prices);
  return { port, balances, prices, valuation, delegates, profiles, warnings };
}

export type EvaluatedTrade = {
  trade: PlannedTrade;
  decision: RiskDecision;
  prepared?: PreparedSwap;
  error?: string;
};

export type Proposal = {
  snapshot: PortSnapshot;
  plan: RebalancePlan;
  trades: EvaluatedTrade[];
};

/**
 * Deterministic proposal: plan from positions + validated prices, then quote and validate each
 * trade for the Asset Signer and run every policy check against the live quote.
 */
export async function proposeRebalance(ctx: AgentContext, asset: string): Promise<Proposal> {
  const snapshot = await loadSnapshot(ctx, asset);
  const { port, valuation, prices, profiles } = snapshot;
  const plan = planRebalance(port.strategy, valuation, prices);
  const trades = await evaluateTrades(ctx, snapshot, plan.trades);
  return { snapshot, plan, trades };
}

async function evaluateTrades(ctx: AgentContext, snapshot: PortSnapshot, planned: PlannedTrade[]): Promise<EvaluatedTrade[]> {
  const { port, valuation, prices, profiles } = snapshot;
  const asset = port.asset;
  const jupiter = ctx.jupiter ?? new JupiterTradeAdapter();
  let dailyUsed = await ctx.activity.dailyNotionalE8(asset);
  const trades: EvaluatedTrade[] = [];
  for (const original of planned) {
    let trade = original;
    let result = await quoteAndEvaluate(ctx, snapshot, jupiter, trade, dailyUsed);
    // Thin pre-IPO books: when only market impact fails, halve and re-quote (smallest trade that
    // still moves toward target), up to three times.
    for (let i = 0; i < 3 && onlyImpactFailed(result.decision); i++) {
      const notionalE8 = trade.notionalE8 / 2n;
      trade = { ...trade, notionalE8, amountIn: trade.amountIn / 2n, reasons: [...trade.reasons, `reduced to $${fromBaseUnits(notionalE8, 8, 2)} for market impact`] };
      result = await quoteAndEvaluate(ctx, snapshot, jupiter, trade, dailyUsed);
    }
    if (result.decision.allowed) dailyUsed += trade.notionalE8;
    trades.push(result);
  }
  return trades;
}

function onlyImpactFailed(d: RiskDecision): boolean {
  const failed = d.checks.filter((c) => !c.passed).map((c) => c.code);
  return failed.length > 0 && failed.every((c) => c === "QUOTE_VS_ORACLE");
}

async function quoteAndEvaluate(ctx: AgentContext, snapshot: PortSnapshot, jupiter: JupiterTradeAdapter, trade: PlannedTrade, dailyUsed: bigint): Promise<EvaluatedTrade> {
  const { port, valuation, prices, profiles } = snapshot;
  const inInfo = await fetchMintInfo(ctx.umi, publicKey(trade.inputMint));
  const outInfo = await fetchMintInfo(ctx.umi, publicKey(trade.outputMint));
  const fee = (m: string) => profiles.get(m)?.transferFeeBps ?? 0;
  let prepared: PreparedSwap | undefined;
  let error: string | undefined;
  try {
    prepared = await jupiter.prepare(
      {
        inputMint: trade.inputMint, outputMint: trade.outputMint, amountIn: trade.amountIn, slippageBps: port.strategy.maxSlippageBps,
        inputTransferFeeBps: fee(trade.inputMint), outputTransferFeeBps: fee(trade.outputMint),
      },
      { authority: port.signer, sourceTokenAccount: ataFor(ctx.umi, inInfo, port.signer), destinationTokenAccount: ataFor(ctx.umi, outInfo, port.signer) },
    );
  } catch (e) {
    error = (e as Error).message;
  }
  const decision = evaluateTrade({
    strategy: port.strategy, valuation, prices, trade, quote: prepared?.quote, allowedPrograms: TRADE_PROGRAM_ALLOWLIST,
    now: Math.floor(Date.now() / 1000), dailyNotionalUsedE8: dailyUsed,
  });
  if (error) {
    decision.checks.push({ code: "ROUTE_AVAILABLE", passed: false, message: `No valid route: ${error}` });
    decision.allowed = false;
  }
  return { trade, decision, prepared, error };
}

/** A single discretionary trade (e.g. the new owner's first trade), under the same policy. */
export async function proposeTrade(ctx: AgentContext, asset: string, req: { side: "buy" | "sell"; symbol: string; notionalUsd: string }): Promise<{ snapshot: PortSnapshot; trade: EvaluatedTrade }> {
  const snapshot = await loadSnapshot(ctx, asset);
  const { port, valuation } = snapshot;
  const pos = valuation.positions.find((p) => p.symbol === req.symbol && p.mint !== port.strategy.cashMint);
  const cash = valuation.positions.find((p) => p.mint === port.strategy.cashMint);
  if (!pos || !cash) throw new Error(`${req.symbol} is not a position in this PORT's mandate`);
  if (!pos.priceE8 || !cash.priceE8) throw new Error("Prices unavailable; refusing to size a trade");
  const notionalE8 = toBaseUnits(req.notionalUsd, 8);
  const trade: PlannedTrade = req.side === "buy"
    ? { side: "buy", mint: pos.mint, symbol: pos.symbol, notionalE8, amountIn: unitsForNotional(notionalE8, cash.decimals, cash.priceE8), inputMint: cash.mint, outputMint: pos.mint, reasons: [`Discretionary buy of $${req.notionalUsd} ${pos.symbol}`] }
    : { side: "sell", mint: pos.mint, symbol: pos.symbol, notionalE8, amountIn: unitsForNotional(notionalE8, pos.decimals, pos.priceE8), inputMint: pos.mint, outputMint: cash.mint, reasons: [`Discretionary sell of $${req.notionalUsd} ${pos.symbol}`] };
  const [evaluated] = await evaluateTrades(ctx, snapshot, [trade]);
  return { snapshot, trade: evaluated! };
}

/** Executes one evaluated trade and records it; refuses anything the policy did not approve. */
export async function executeEvaluated(ctx: AgentContext, asset: string, t: EvaluatedTrade, as: "owner" | "delegate"): Promise<PortActivity> {
  const base = activityBase(ctx, asset, t, as);
  if (!t.decision.allowed || !t.prepared) return ctx.activity.append({ ...base, status: "failed", details: { ...base.details, reason: "blocked by policy" } });
  const record = await ctx.activity.append({ ...base, status: "submitted" });
  try {
    const tx = await submitPrepared(ctx.umi, asset, t.prepared.instructions, t.prepared.addressLookupTables, as);
    await ctx.activity.update(record.id, { status: "confirmed", signature: tx.signature });
    return { ...record, status: "confirmed", signature: tx.signature };
  } catch (e) {
    await ctx.activity.update(record.id, { status: "failed", details: { ...base.details, error: (e as Error).message } });
    return { ...record, status: "failed", details: { ...base.details, error: (e as Error).message } };
  }
}

function activityBase(ctx: AgentContext, asset: string, t: EvaluatedTrade, as: "owner" | "delegate") {
  return {
    portAsset: asset, actor: ctx.umi.identity.publicKey, authority: as, action: "trade" as const, rationale: t.trade.reasons.join("; "), riskDecision: t.decision,
    details: {
      side: t.trade.side, symbol: t.trade.symbol, notionalE8: t.trade.notionalE8.toString(), amountIn: t.trade.amountIn.toString(), route: t.prepared?.routeLabels ?? [],
      quote: t.prepared ? { outAmount: t.prepared.quote.outAmount.toString(), minOutAmount: t.prepared.quote.minOutAmount.toString(), transferFeeBps: t.prepared.quote.transferFeeBps ?? 0 } : undefined,
    } as Record<string, unknown>,
  };
}

export type ExecutionResult = { trade: PlannedTrade; decision: RiskDecision; activity: PortActivity };

/**
 * Executes approved trades as the connected authority (owner or delegate), one Core Execute
 * transaction per trade, using quotes fetched moments earlier in the same run (the on-chain
 * minimum-out bounds any drift). Stops at the first failed transaction.
 */
export async function executeRebalance(ctx: AgentContext, asset: string, as: "owner" | "delegate", maxTrades = 8): Promise<{ proposal: Proposal; results: ExecutionResult[] }> {
  const proposal = await proposeRebalance(ctx, asset);
  const results: ExecutionResult[] = [];
  for (const t of proposal.trades.slice(0, maxTrades)) {
    const activity = await executeEvaluated(ctx, asset, t, as);
    results.push({ trade: t.trade, decision: t.decision, activity });
    if (t.decision.allowed && activity.status === "failed") break;
  }
  return { proposal, results };
}

export async function submitPrepared(umi: Umi, asset: string, instructions: Instruction[], lookupTables: string[], as: "owner" | "delegate") {
  return guardedExecute(umi, {
    asset: publicKey(asset),
    instructions,
    allowedPrograms: TRADE_PROGRAM_ALLOWLIST,
    as: { authority: as },
    computeUnits: 1_000_000,
    addressLookupTables: await fetchLookupTables(umi, lookupTables),
  });
}
