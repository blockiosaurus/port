import { describe, expect, it } from "vitest";
import { PortStrategySchema, toBaseUnits, fromBaseUnits, type PriceSnapshot } from "@port/shared";
import { evaluateTrade, planRebalance, unitsForNotional, valueE8, valuePortfolio, type Holding, type TradeQuote } from "../src";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const AAA = "So11111111111111111111111111111111111111112";
const BBB = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const NOW = 1_800_000_000;
const $ = (usd: number) => BigInt(Math.round(usd * 100)) * 1_000_000n;

const strategy = PortStrategySchema.parse({
  version: 1,
  name: "Test",
  targets: [
    { mint: AAA, symbol: "AAA", weightBps: 5000 },
    { mint: BBB, symbol: "BBB", weightBps: 4000 },
    { mint: USDC, symbol: "USDC", weightBps: 1000 },
  ],
  cashMint: USDC,
  minCashWeightBps: 500,
  rebalanceToleranceBps: 200,
  maxPositionWeightBps: 5500,
  maxTradeNavBps: 1500,
  maxPriceAgeSeconds: 60,
  maxSpreadBps: 100,
  closedMarketSpreadBps: 300,
  highVolatilityThresholdBps: 500,
  maxDailyNotionalBps: 5000,
  maxSlippageBps: 100,
});

const price = (mint: string, symbol: string, usd: number, extra: Partial<PriceSnapshot> = {}): PriceSnapshot => ({
  mint, symbol, priceE8: $(usd), confE8: $(usd) / 2000n, publishTime: NOW - 5, source: "test", ...extra,
});
const basePrices = () =>
  new Map<string, PriceSnapshot>([
    [AAA, price(AAA, "AAA", 100, { referencePriceE8: $(100.2), marketSession: "open" })],
    [BBB, price(BBB, "BBB", 50, { referencePriceE8: $(50), marketSession: "open" })],
    [USDC, price(USDC, "USDC", 1)],
  ]);
const holdings = (aaa: string, bbb: string, usdc: string): Holding[] => [
  { mint: AAA, symbol: "AAA", decimals: 6, amount: toBaseUnits(aaa, 6) },
  { mint: BBB, symbol: "BBB", decimals: 9, amount: toBaseUnits(bbb, 9) },
  { mint: USDC, symbol: "USDC", decimals: 6, amount: toBaseUnits(usdc, 6) },
];

describe("decimals", () => {
  it.each([
    ["1", 6, 1_000_000n],
    ["0.000001", 6, 1n],
    ["12.5", 9, 12_500_000_000n],
    ["0", 0, 0n],
  ])("toBaseUnits(%s, %i)", (s, d, want) => expect(toBaseUnits(s, d)).toBe(want));
  it("rejects excess precision and junk", () => {
    expect(() => toBaseUnits("0.0000001", 6)).toThrow();
    expect(() => toBaseUnits("1e6", 6)).toThrow();
    expect(() => toBaseUnits("-1", 6)).toThrow();
  });
  it("round-trips", () => expect(fromBaseUnits(toBaseUnits("123.4567", 6), 6)).toBe("123.4567"));
  it("values and sizes with floor rounding", () => {
    expect(valueE8(1_500_000n, 6, $(2))).toBe($(3));
    expect(unitsForNotional($(1), 6, $(3))).toBe(333_333n); // floor, never over-spend
    expect(valueE8(1n, 9, 1n)).toBe(0n);
  });
});

describe("strategy schema", () => {
  it("rejects weights not totaling 10,000 bps", () => {
    const bad = { ...strategy, targets: [{ mint: AAA, symbol: "AAA", weightBps: 9000 }, { mint: USDC, symbol: "USDC", weightBps: 900 }] };
    expect(PortStrategySchema.safeParse(bad).success).toBe(false);
  });
  it("rejects a target above max position weight", () => {
    const bad = { ...strategy, targets: [{ mint: AAA, symbol: "AAA", weightBps: 9000 }, { mint: USDC, symbol: "USDC", weightBps: 1000 }] };
    expect(PortStrategySchema.safeParse(bad).success).toBe(false);
  });
});

describe("valuation", () => {
  it("computes NAV, weights and drift", () => {
    const v = valuePortfolio(strategy, holdings("50", "80", "1000"), basePrices());
    expect(v.navE8).toBe($(10_000));
    expect(v.positions.map((p) => [p.symbol, p.weightBps, p.driftBps])).toEqual([
      ["AAA", 5000, 0], ["BBB", 4000, 0], ["USDC", 1000, 0],
    ]);
  });
  it("flags unpriced holdings", () => {
    const prices = basePrices();
    prices.delete(BBB);
    expect(valuePortfolio(strategy, holdings("50", "80", "1000"), prices).unpriced).toEqual([BBB]);
  });
});

describe("planRebalance", () => {
  it("does nothing within tolerance", () => {
    const p = basePrices();
    const plan = planRebalance(strategy, valuePortfolio(strategy, holdings("51", "79", "1000"), p), p);
    expect(plan.withinTolerance).toBe(true);
    expect(plan.trades).toEqual([]);
  });
  it("buys underweight from excess cash, respecting the cash floor", () => {
    const p = basePrices();
    // AAA 40% (-10%), BBB 40%, cash 20%.
    const v = valuePortfolio(strategy, holdings("40", "80", "2000"), p);
    const plan = planRebalance(strategy, v, p);
    expect(plan.trades).toHaveLength(1);
    const [t] = plan.trades;
    expect(t).toMatchObject({ side: "buy", symbol: "AAA", inputMint: USDC, outputMint: AAA, notionalE8: $(1000), amountIn: toBaseUnits("1000", 6) });
  });
  it("sells overweight before buying and caps at max trade size", () => {
    const p = basePrices();
    // AAA 70% (+20%), BBB 20% (-20%), cash 10%.
    const v = valuePortfolio(strategy, holdings("70", "40", "1000"), p);
    const plan = planRebalance(strategy, v, p);
    expect(plan.trades.map((t) => [t.side, t.symbol, t.notionalE8])).toEqual([
      ["sell", "AAA", $(1500)],
      ["buy", "BBB", $(1500)],
    ]);
    expect(plan.trades[0]!.reasons.join()).toMatch(/max trade size/);
  });
  it("halves size under high volatility", () => {
    const p = basePrices();
    p.set(AAA, { ...p.get(AAA)!, volatilityBps: 800 });
    const plan = planRebalance(strategy, valuePortfolio(strategy, holdings("40", "80", "2000"), p), p);
    expect(plan.trades[0]!.notionalE8).toBe($(500));
    expect(plan.trades[0]!.reasons.join()).toMatch(/volatility/);
  });
  it("is deterministic", () => {
    const p = basePrices();
    const v = valuePortfolio(strategy, holdings("70", "40", "1000"), p);
    expect(planRebalance(strategy, v, p)).toEqual(planRebalance(strategy, v, p));
  });
  it("refuses to plan with missing prices", () => {
    const p = basePrices();
    p.delete(AAA);
    const plan = planRebalance(strategy, valuePortfolio(strategy, holdings("40", "80", "2000"), p), p);
    expect(plan.trades).toEqual([]);
    expect(plan.rationale).toMatch(/missing prices/);
  });
});

describe("evaluateTrade", () => {
  const setup = (mut: (p: Map<string, PriceSnapshot>) => void = () => {}) => {
    const p = basePrices();
    mut(p);
    const v = valuePortfolio(strategy, holdings("40", "80", "2000"), basePrices());
    const trade = planRebalance(strategy, v, basePrices()).trades[0]!;
    const quote: TradeQuote = { inAmount: trade.amountIn, outAmount: toBaseUnits("10", 6), minOutAmount: toBaseUnits("9.95", 6), slippageBps: 50, programIds: ["JUP"] };
    return { strategy, valuation: v, prices: p, trade, quote, now: NOW, allowedPrograms: ["JUP"] };
  };
  const failed = (d: ReturnType<typeof evaluateTrade>) => d.checks.filter((c) => !c.passed).map((c) => c.code);

  it("approves a clean trade", () => {
    const d = evaluateTrade(setup());
    expect(failed(d)).toEqual([]);
    expect(d.allowed).toBe(true);
  });

  it.each<[string, (p: Map<string, PriceSnapshot>) => void, string]>([
    ["stale price", (p) => p.set(AAA, { ...p.get(AAA)!, publishTime: NOW - 120 }), "PRICE_FRESH"],
    ["stale cash price", (p) => p.set(USDC, { ...p.get(USDC)!, publishTime: NOW - 61 }), "PRICE_FRESH"],
    ["future-dated price", (p) => p.set(AAA, { ...p.get(AAA)!, publishTime: NOW + 60 }), "PRICE_FRESH"],
    ["wide confidence", (p) => p.set(AAA, { ...p.get(AAA)!, confE8: $(2) }), "PRICE_CONFIDENCE"],
    ["reference spread (open)", (p) => p.set(AAA, { ...p.get(AAA)!, referencePriceE8: $(98) }), "REFERENCE_SPREAD"],
    ["missing reference", (p) => p.set(AAA, { ...p.get(AAA)!, referencePriceE8: undefined }), "REFERENCE_SPREAD"],
    ["extreme volatility", (p) => p.set(AAA, { ...p.get(AAA)!, volatilityBps: 1500 }), "VOLATILITY"],
    ["missing price", (p) => p.delete(AAA), "PRICE_AVAILABLE"],
  ])("blocks on %s", (_, mut, code) => {
    const d = evaluateTrade(setup(mut));
    expect(d.allowed).toBe(false);
    expect(failed(d)).toContain(code);
  });

  it("uses the wider closed-market spread when the session is closed", () => {
    const d = evaluateTrade(setup((p) => p.set(AAA, { ...p.get(AAA)!, referencePriceE8: $(98), marketSession: "closed" })));
    expect(failed(d)).toEqual([]);
  });

  it("allows missing reference only for declared pre-IPO mints", () => {
    const ctx = { ...setup((p) => p.set(AAA, { ...p.get(AAA)!, referencePriceE8: undefined })), referenceOptionalMints: [AAA] };
    expect(evaluateTrade(ctx).allowed).toBe(true);
  });

  it("blocks oversized trades", () => {
    const ctx = setup();
    const d = evaluateTrade({ ...ctx, trade: { ...ctx.trade, notionalE8: $(1600) } });
    expect(failed(d)).toContain("MAX_TRADE_SIZE");
  });

  it("enforces cash floor", () => {
    const p = basePrices();
    const v = valuePortfolio(strategy, holdings("40", "80", "2000"), p);
    const ctx = setup();
    const trade = { ...ctx.trade, notionalE8: $(1500), amountIn: toBaseUnits("1500", 6) };
    const d = evaluateTrade({ ...ctx, valuation: v, trade, quote: { ...ctx.quote, inAmount: trade.amountIn } });
    // cash 20% -> 5%: at floor, passes; one more dollar breaks it.
    expect(failed(d)).not.toContain("CASH_FLOOR");
    const d2 = evaluateTrade({ ...ctx, valuation: v, trade: { ...trade, notionalE8: $(1501) } });
    expect(failed(d2)).toContain("CASH_FLOOR");
  });

  it("enforces max position weight", () => {
    const p = basePrices();
    const v = valuePortfolio(strategy, holdings("50", "60", "2000"), p); // AAA 50%
    const ctx = setup();
    const d = evaluateTrade({ ...ctx, valuation: v, trade: { ...ctx.trade, notionalE8: $(600) } });
    expect(failed(d)).toContain("MAX_POSITION_WEIGHT");
  });

  it("enforces daily notional", () => {
    expect(failed(evaluateTrade({ ...setup(), dailyNotionalUsedE8: $(4500) }))).toContain("DAILY_NOTIONAL");
  });

  it.each<[string, Partial<TradeQuote>, string]>([
    ["slippage above limit", { slippageBps: 150 }, "SLIPPAGE_LIMIT"],
    ["zero min out", { minOutAmount: 0n }, "SLIPPAGE_LIMIT"],
    ["min out far below oracle", { minOutAmount: toBaseUnits("9", 6) }, "QUOTE_VS_ORACLE"],
    ["input mismatch", { inAmount: 1n }, "QUOTE_INPUT_MATCH"],
    ["unknown program", { programIds: ["JUP", "EVIL"] }, "PROGRAM_ALLOWLIST"],
  ])("blocks quote with %s", (_, q, code) => {
    const ctx = setup();
    expect(failed(evaluateTrade({ ...ctx, quote: { ...ctx.quote, ...q } }))).toContain(code);
  });

  it("counts transfer fees in the execution limit and caps the fee", () => {
    const ctx = setup();
    // 1% fee + 1% slippage: min out 9.80 on a $1000 buy stays inside spread+slippage+fee.
    const q = { ...ctx.quote, minOutAmount: toBaseUnits("9.75", 6), transferFeeBps: 100 };
    expect(failed(evaluateTrade({ ...ctx, quote: q }))).toEqual([]);
    expect(failed(evaluateTrade({ ...ctx, quote: { ...q, transferFeeBps: 500 } }))).toContain("TRANSFER_FEE");
  });

  it("applies a per-asset reference band for pre-IPO premiums", () => {
    const wide = PortStrategySchema.parse({ ...strategy, targets: strategy.targets.map((t) => (t.mint === AAA ? { ...t, maxReferenceDeviationBps: 2500 } : t)) });
    const mut = (p: Map<string, PriceSnapshot>) => p.set(AAA, { ...p.get(AAA)!, referencePriceE8: $(85) }); // +17.6% premium
    expect(failed(evaluateTrade(setup(mut)))).toContain("REFERENCE_SPREAD");
    expect(failed(evaluateTrade({ ...setup(mut), strategy: wide }))).toEqual([]);
  });

  it("blocks a stale reference", () => {
    const d = evaluateTrade(setup((p) => p.set(AAA, { ...p.get(AAA)!, referencePublishTime: NOW - 600 })));
    expect(failed(d)).toContain("REFERENCE_FRESH");
  });

  it("fails closed without a quote", () => {
    expect(failed(evaluateTrade({ ...setup(), quote: undefined }))).toContain("QUOTE_PRESENT");
  });

  it("blocks non-strategy mints", () => {
    const ctx = setup();
    const d = evaluateTrade({ ...ctx, trade: { ...ctx.trade, outputMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" } });
    expect(failed(d)).toContain("MINT_ALLOWLIST");
  });
});
