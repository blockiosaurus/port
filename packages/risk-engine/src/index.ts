import { BPS, type PortStrategy, type PriceSnapshot, type RiskCheck, type RiskDecision } from "@port/shared";

const E8 = 100_000_000n;
const bps = BigInt(BPS);

export type Holding = { mint: string; symbol: string; decimals: number; amount: bigint };

export type PositionValuation = Holding & {
  priceE8: bigint | null;
  valueE8: bigint;
  weightBps: number;
  targetBps: number;
  driftBps: number;
};

export type Valuation = {
  navE8: bigint;
  positions: PositionValuation[];
  /** Mints held or targeted that have no price; valuation is incomplete when non-empty. */
  unpriced: string[];
};

export type PlannedTrade = {
  side: "buy" | "sell";
  mint: string;
  symbol: string;
  /** USD notional of the trade (1e8 scale). */
  notionalE8: bigint;
  /** Amount of the input token in base units (USDC for buys, the position for sells). */
  amountIn: bigint;
  inputMint: string;
  outputMint: string;
  /** Why this trade exists and how it was sized. */
  reasons: string[];
};

export type RebalancePlan = {
  withinTolerance: boolean;
  trades: PlannedTrade[];
  rationale: string;
};

export type TradeQuote = {
  inAmount: bigint;
  outAmount: bigint;
  /** Minimum out enforced on-chain by the downstream program. */
  minOutAmount: bigint;
  slippageBps: number;
  programIds: string[];
};

/** Integer value of `amount` base units at `priceE8` USD per whole token. */
export function valueE8(amount: bigint, decimals: number, priceE8: bigint): bigint {
  return (amount * priceE8) / 10n ** BigInt(decimals);
}

/** Base units purchasable for `notionalE8` at `priceE8`, rounded down. */
export function unitsForNotional(notionalE8: bigint, decimals: number, priceE8: bigint): bigint {
  if (priceE8 <= 0n) throw new Error("price must be positive");
  return (notionalE8 * 10n ** BigInt(decimals)) / priceE8;
}

const ratioBps = (num: bigint, den: bigint): number => (den === 0n ? 0 : Number((num * bps) / den));
const absDiffBps = (a: bigint, b: bigint): number => {
  if (b === 0n) return Number.POSITIVE_INFINITY;
  const d = a > b ? a - b : b - a;
  return Number((d * bps) / b);
};

export function valuePortfolio(
  strategy: PortStrategy,
  holdings: Holding[],
  prices: ReadonlyMap<string, PriceSnapshot>,
): Valuation {
  const byMint = new Map(holdings.map((h) => [h.mint, h]));
  const unpriced: string[] = [];
  const rows = strategy.targets.map((t) => {
    const h = byMint.get(t.mint);
    const holding: Holding = h ?? { mint: t.mint, symbol: t.symbol, decimals: 0, amount: 0n };
    const price = prices.get(t.mint)?.priceE8 ?? null;
    if (price === null && holding.amount > 0n) unpriced.push(t.mint);
    return { ...holding, symbol: t.symbol, priceE8: price, valueE8: price === null ? 0n : valueE8(holding.amount, holding.decimals, price), targetBps: t.weightBps };
  });
  for (const h of holdings)
    if (!strategy.targets.some((t) => t.mint === h.mint) && h.amount > 0n) unpriced.push(h.mint);
  const navE8 = rows.reduce((a, r) => a + r.valueE8, 0n);
  const positions = rows.map((r) => {
    const weightBps = ratioBps(r.valueE8, navE8);
    return { ...r, weightBps, driftBps: weightBps - r.targetBps };
  });
  return { navE8, positions, unpriced };
}

/**
 * Deterministic, bounded rebalance: only positions outside tolerance trade, each trade moves
 * the position to target, capped by max trade size, and buys are funded only from cash above
 * the floor (including proceeds of planned sells). Ordering is stable: sells first, larger
 * absolute drift first, then mint.
 */
export function planRebalance(
  strategy: PortStrategy,
  valuation: Valuation,
  prices: ReadonlyMap<string, PriceSnapshot>,
): RebalancePlan {
  if (valuation.unpriced.length > 0)
    return { withinTolerance: false, trades: [], rationale: `Cannot plan: missing prices for ${valuation.unpriced.join(", ")}.` };
  if (valuation.navE8 === 0n) return { withinTolerance: true, trades: [], rationale: "Portfolio is empty; nothing to rebalance." };

  const nav = valuation.navE8;
  const cash = valuation.positions.find((p) => p.mint === strategy.cashMint);
  if (!cash) throw new Error("cash position missing from valuation");
  const maxTrade = (nav * BigInt(strategy.maxTradeNavBps)) / bps;
  const cashFloor = (nav * BigInt(strategy.minCashWeightBps)) / bps;

  const drifting = valuation.positions
    .filter((p) => p.mint !== strategy.cashMint && Math.abs(p.driftBps) > strategy.rebalanceToleranceBps)
    .sort((a, b) => Math.abs(b.driftBps) - Math.abs(a.driftBps) || a.mint.localeCompare(b.mint));

  if (drifting.length === 0)
    return {
      withinTolerance: true,
      trades: [],
      rationale: `All positions within ±${strategy.rebalanceToleranceBps / 100}% of target. No trade needed.`,
    };

  const trades: PlannedTrade[] = [];
  let cashAvailable = cash.valueE8;

  const sized = (p: PositionValuation, wanted: bigint, reasons: string[]): bigint => {
    let n = wanted;
    if (n > maxTrade) {
      n = maxTrade;
      reasons.push(`capped at max trade size ${strategy.maxTradeNavBps / 100}% of NAV`);
    }
    const vol = prices.get(p.mint)?.volatilityBps;
    const volLimit = strategy.highVolatilityThresholdBps;
    if (vol !== undefined && volLimit !== undefined && vol > volLimit) {
      n = n / 2n;
      reasons.push(`halved: volatility ${vol / 100}% above ${volLimit / 100}% threshold`);
    }
    return n;
  };

  for (const p of drifting.filter((d) => d.driftBps > 0)) {
    const target = (nav * BigInt(p.targetBps)) / bps;
    const reasons = [`${p.symbol} at ${p.weightBps / 100}% vs target ${p.targetBps / 100}% (+${p.driftBps / 100}%)`];
    const notional = sized(p, p.valueE8 - target, reasons);
    const amountIn = unitsForNotional(notional, p.decimals, p.priceE8!);
    if (amountIn === 0n) continue;
    trades.push({ side: "sell", mint: p.mint, symbol: p.symbol, notionalE8: notional, amountIn, inputMint: p.mint, outputMint: strategy.cashMint, reasons });
    cashAvailable += notional;
  }

  for (const p of drifting.filter((d) => d.driftBps < 0)) {
    const target = (nav * BigInt(p.targetBps)) / bps;
    const reasons = [`${p.symbol} at ${p.weightBps / 100}% vs target ${p.targetBps / 100}% (${p.driftBps / 100}%)`];
    let notional = sized(p, target - p.valueE8, reasons);
    const spendable = cashAvailable - cashFloor;
    if (spendable <= 0n) {
      reasons.push("skipped: cash at minimum floor");
      continue;
    }
    if (notional > spendable) {
      notional = spendable;
      reasons.push(`limited by cash above the ${strategy.minCashWeightBps / 100}% floor`);
    }
    const amountIn = unitsForNotional(notional, cash.decimals, cash.priceE8!);
    if (amountIn === 0n) continue;
    trades.push({ side: "buy", mint: p.mint, symbol: p.symbol, notionalE8: notional, amountIn, inputMint: strategy.cashMint, outputMint: p.mint, reasons });
    cashAvailable -= notional;
  }

  const rationale = trades.length
    ? trades.map((t) => `${t.side.toUpperCase()} ${t.symbol} ≈ $${fmtE8(t.notionalE8)}: ${t.reasons.join("; ")}.`).join(" ")
    : "Drift detected but no executable trade after limits.";
  return { withinTolerance: false, trades, rationale };
}

export type TradeContext = {
  strategy: PortStrategy;
  valuation: Valuation;
  prices: ReadonlyMap<string, PriceSnapshot>;
  trade: PlannedTrade;
  quote?: TradeQuote;
  /** Programs the quote's instructions invoke must be in this list. */
  allowedPrograms?: readonly string[];
  now: number;
  dailyNotionalUsedE8?: bigint;
  /** Mints for which no reference instrument exists (e.g. pre-IPO). */
  referenceOptionalMints?: readonly string[];
};

/** Every check always runs so the explanation is complete; allowed only when all pass. */
export function evaluateTrade(ctx: TradeContext): RiskDecision {
  const { strategy: s, valuation: v, prices, trade, quote, now } = ctx;
  const checks: RiskCheck[] = [];
  const add = (c: RiskCheck) => checks.push(c);
  const nav = v.navE8;
  const targetMints = new Set(s.targets.map((t) => t.mint));

  add({
    code: "MINT_ALLOWLIST",
    passed: targetMints.has(trade.inputMint) && targetMints.has(trade.outputMint) && (trade.inputMint === s.cashMint || trade.outputMint === s.cashMint),
    observed: `${trade.inputMint.slice(0, 4)}→${trade.outputMint.slice(0, 4)}`,
    message: "Both legs must be strategy mints and one leg must be cash.",
  });

  add({
    code: "VALUATION_COMPLETE",
    passed: v.unpriced.length === 0 && nav > 0n,
    observed: v.unpriced.length,
    limit: 0,
    message: v.unpriced.length ? `Missing prices for ${v.unpriced.length} holding(s).` : "All holdings priced.",
  });

  for (const mint of [trade.mint, s.cashMint]) {
    const p = prices.get(mint);
    const sym = s.targets.find((t) => t.mint === mint)?.symbol ?? mint.slice(0, 4);
    if (!p) {
      add({ code: "PRICE_AVAILABLE", passed: false, message: `No price for ${sym}; failing closed.` });
      continue;
    }
    const age = now - p.publishTime;
    add({ code: "PRICE_FRESH", passed: age >= -5 && age <= s.maxPriceAgeSeconds, observed: `${age}s`, limit: `${s.maxPriceAgeSeconds}s`, message: `${sym} price age from ${p.source}.` });
    const confBps = p.priceE8 > 0n ? Number((p.confE8 * bps) / p.priceE8) : Number.POSITIVE_INFINITY;
    add({ code: "PRICE_CONFIDENCE", passed: confBps <= s.maxSpreadBps, observed: `${confBps}bps`, limit: `${s.maxSpreadBps}bps`, message: `${sym} oracle confidence interval.` });
  }

  const p = prices.get(trade.mint);
  if (p) {
    const closed = p.marketSession === "closed";
    const limit = closed && s.closedMarketSpreadBps !== undefined ? s.closedMarketSpreadBps : s.maxSpreadBps;
    if (p.referencePriceE8 !== undefined) {
      const dev = absDiffBps(p.priceE8, p.referencePriceE8);
      add({
        code: "REFERENCE_SPREAD",
        passed: dev <= limit,
        observed: `${dev}bps`,
        limit: `${limit}bps (${closed ? "market closed" : p.marketSession === "open" ? "market open" : "session unknown"})`,
        message: `${trade.symbol} tokenized price vs reference.`,
      });
    } else {
      const optional = ctx.referenceOptionalMints?.includes(trade.mint) ?? false;
      add({
        code: "REFERENCE_SPREAD",
        passed: optional,
        message: optional ? `${trade.symbol} has no public reference instrument (pre-IPO); quote-vs-oracle check applies.` : `${trade.symbol} reference price unavailable; failing closed.`,
      });
    }
    const vol = p.volatilityBps;
    const volLimit = s.highVolatilityThresholdBps;
    if (vol !== undefined && volLimit !== undefined)
      add({ code: "VOLATILITY", passed: vol <= volLimit * 2, observed: `${vol}bps`, limit: `${volLimit * 2}bps`, message: "Trades above the threshold are halved; above 2× they are rejected." });
  }

  const maxTrade = (nav * BigInt(s.maxTradeNavBps)) / bps;
  add({ code: "MAX_TRADE_SIZE", passed: trade.notionalE8 <= maxTrade, observed: `$${fmtE8(trade.notionalE8)}`, limit: `$${fmtE8(maxTrade)}`, message: `Trade notional ≤ ${s.maxTradeNavBps / 100}% of NAV.` });

  if (s.maxDailyNotionalBps !== undefined) {
    const used = ctx.dailyNotionalUsedE8 ?? 0n;
    const cap = (nav * BigInt(s.maxDailyNotionalBps)) / bps;
    add({ code: "DAILY_NOTIONAL", passed: used + trade.notionalE8 <= cap, observed: `$${fmtE8(used + trade.notionalE8)}`, limit: `$${fmtE8(cap)}`, message: "Rolling 24h traded notional." });
  }

  // Post-trade weights, valued at oracle prices.
  const after = new Map(v.positions.map((x) => [x.mint, x.valueE8]));
  const delta = trade.side === "buy" ? trade.notionalE8 : -trade.notionalE8;
  after.set(trade.mint, (after.get(trade.mint) ?? 0n) + delta);
  after.set(s.cashMint, (after.get(s.cashMint) ?? 0n) - delta);
  const cashAfter = after.get(s.cashMint) ?? 0n;
  const cashAfterBps = ratioBps(cashAfter, nav);
  add({ code: "CASH_FLOOR", passed: cashAfter >= 0n && cashAfterBps >= s.minCashWeightBps, observed: `${cashAfterBps / 100}%`, limit: `${s.minCashWeightBps / 100}%`, message: "Post-trade cash weight." });
  const posAfterBps = ratioBps(after.get(trade.mint) ?? 0n, nav);
  add({ code: "MAX_POSITION_WEIGHT", passed: trade.side === "sell" || posAfterBps <= s.maxPositionWeightBps, observed: `${posAfterBps / 100}%`, limit: `${s.maxPositionWeightBps / 100}%`, message: `Post-trade ${trade.symbol} weight.` });

  if (quote) {
    add({ code: "QUOTE_INPUT_MATCH", passed: quote.inAmount === trade.amountIn, observed: quote.inAmount.toString(), limit: trade.amountIn.toString(), message: "Quote input equals the planned amount." });
    add({ code: "SLIPPAGE_LIMIT", passed: quote.slippageBps <= s.maxSlippageBps && quote.minOutAmount > 0n && quote.minOutAmount <= quote.outAmount, observed: `${quote.slippageBps}bps`, limit: `${s.maxSlippageBps}bps`, message: "Quoted slippage bound enforced on-chain via minimum out." });
    const inPrice = prices.get(trade.inputMint);
    const outPrice = prices.get(trade.outputMint);
    const outDecimals = v.positions.find((x) => x.mint === trade.outputMint)?.decimals;
    const inDecimals = v.positions.find((x) => x.mint === trade.inputMint)?.decimals;
    if (inPrice && outPrice && outDecimals !== undefined && inDecimals !== undefined) {
      const inUsd = valueE8(quote.inAmount, inDecimals, inPrice.priceE8);
      const minOutUsd = valueE8(quote.minOutAmount, outDecimals, outPrice.priceE8);
      const shortfall = inUsd > minOutUsd ? Number(((inUsd - minOutUsd) * bps) / (inUsd || 1n)) : 0;
      const limit = s.maxSpreadBps + s.maxSlippageBps;
      add({ code: "QUOTE_VS_ORACLE", passed: shortfall <= limit, observed: `${shortfall}bps`, limit: `${limit}bps`, message: "Worst-case execution value vs oracle value." });
    } else {
      add({ code: "QUOTE_VS_ORACLE", passed: false, message: "Cannot compare quote to oracle; failing closed." });
    }
    if (ctx.allowedPrograms) {
      const bad = quote.programIds.filter((id) => !ctx.allowedPrograms!.includes(id));
      add({ code: "PROGRAM_ALLOWLIST", passed: bad.length === 0, observed: bad.length ? bad.join(",") : "ok", message: "Downstream programs must be allowlisted." });
    }
  } else {
    add({ code: "QUOTE_PRESENT", passed: false, message: "No executable quote; failing closed." });
  }

  return { allowed: checks.every((c) => c.passed), checks };
}

export function summarizeDecision(d: RiskDecision): string {
  if (d.allowed) return `Approved: ${d.checks.length} checks passed.`;
  const failed = d.checks.filter((c) => !c.passed);
  return `Blocked by ${failed.map((c) => c.code).join(", ")}: ${failed.map((c) => c.message).join(" ")}`;
}

function fmtE8(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / E8;
  const cents = (a % E8) / 1_000_000n;
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}
