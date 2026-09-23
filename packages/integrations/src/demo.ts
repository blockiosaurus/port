import { PortStrategySchema, type PortStrategy } from "@port/shared";
import { PRESTOCKS } from "./prestocks";
import { USDC_MAINNET } from "./pricing";

const mint = (s: string) => PRESTOCKS.find((p) => p.symbol === s)!.mint;

/**
 * AI Private Markets Fund #001. xAI and Databricks are not issued by PreStocks, so SpaceX and
 * Anduril take their slots. Limits are calibrated to live markets: half-spreads of 30–215 bps, and
 * premiums to the reference mark that ranged from −22% to +31% over 2026-09-22/23 (OpenAI alone
 * moved +16.5% → +30.6% in a day). The 35% band is wide on purpose: it is there to catch a broken
 * mark or a dislocated pool, not to second-guess a persistent pre-IPO premium.
 */
export const DEMO_STRATEGY: PortStrategy = PortStrategySchema.parse({
  version: 1,
  name: "AI Private Markets Fund #001",
  targets: [
    { mint: mint("OPENAI"), symbol: "OPENAI", weightBps: 3000, maxReferenceDeviationBps: 3500 },
    { mint: mint("ANTHROPIC"), symbol: "ANTHROPIC", weightBps: 2500, maxReferenceDeviationBps: 3500 },
    { mint: mint("SPACEX"), symbol: "SPACEX", weightBps: 2000, maxReferenceDeviationBps: 3500 },
    { mint: mint("ANDURIL"), symbol: "ANDURIL", weightBps: 1500, maxReferenceDeviationBps: 3500 },
    { mint: USDC_MAINNET, symbol: "USDC", weightBps: 1000 },
  ],
  cashMint: USDC_MAINNET,
  minCashWeightBps: 500,
  rebalanceToleranceBps: 300,
  maxPositionWeightBps: 3500,
  maxTradeNavBps: 3000,
  maxPriceAgeSeconds: 90,
  maxSpreadBps: 250,
  highVolatilityThresholdBps: 300,
  maxDailyNotionalBps: 10000,
  maxSlippageBps: 100,
  maxTransferFeeBps: 150,
});

export const DEMO_PORT_NAME = "AI Private Markets Fund #001";
