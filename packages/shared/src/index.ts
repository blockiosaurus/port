import { z } from "zod";

export const BPS = 10_000;

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "expected a base58 address");

export const TargetSchema = z.object({
  mint: base58,
  symbol: z.string().min(1).max(16),
  weightBps: z.number().int().min(0).max(BPS),
  /** Allowed |token − reference| band; pre-IPO tokens trade at persistent premiums. */
  maxReferenceDeviationBps: z.number().int().min(0).max(BPS).optional(),
});

export const PortStrategySchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(32),
    benchmark: z.string().optional(),
    targets: z.array(TargetSchema).min(1),
    cashMint: base58,
    minCashWeightBps: z.number().int().min(0).max(BPS),
    rebalanceToleranceBps: z.number().int().min(1).max(BPS),
    maxPositionWeightBps: z.number().int().min(1).max(BPS),
    maxTradeNavBps: z.number().int().min(1).max(BPS),
    maxPriceAgeSeconds: z.number().int().min(1),
    maxSpreadBps: z.number().int().min(0),
    closedMarketSpreadBps: z.number().int().min(0).optional(),
    highVolatilityThresholdBps: z.number().int().min(1).optional(),
    maxDailyNotionalBps: z.number().int().min(1).max(BPS).optional(),
    maxSlippageBps: z.number().int().min(0).max(1_000).default(100),
    maxTransferFeeBps: z.number().int().min(0).max(1_000).default(150),
  })
  .superRefine((s, ctx) => {
    const total = s.targets.reduce((a, t) => a + t.weightBps, 0);
    if (total !== BPS) ctx.addIssue({ code: "custom", message: `target weights total ${total} bps, expected ${BPS}` });
    const mints = new Set(s.targets.map((t) => t.mint));
    if (mints.size !== s.targets.length) ctx.addIssue({ code: "custom", message: "duplicate target mint" });
    if (!mints.has(s.cashMint)) ctx.addIssue({ code: "custom", message: "cash mint must be one of the targets" });
    for (const t of s.targets)
      if (t.mint !== s.cashMint && t.weightBps > s.maxPositionWeightBps)
        ctx.addIssue({ code: "custom", message: `${t.symbol} target exceeds max position weight` });
    const cash = s.targets.find((t) => t.mint === s.cashMint);
    if (cash && cash.weightBps < s.minCashWeightBps)
      ctx.addIssue({ code: "custom", message: "cash target is below the minimum cash weight" });
  });

export type PortStrategy = z.infer<typeof PortStrategySchema>;
export type PortTarget = z.infer<typeof TargetSchema>;

export type RiskCheck = {
  code: string;
  passed: boolean;
  observed?: string | number;
  limit?: string | number;
  message: string;
};

export type RiskDecision = { allowed: boolean; checks: RiskCheck[] };

export type Authority = "owner" | "delegate";
export type ActivityAction = "create" | "deposit" | "trade" | "delegate" | "revoke" | "transfer";
export type ActivityStatus = "proposed" | "submitted" | "confirmed" | "failed";

export const PortActivitySchema = z.object({
  id: z.string(),
  portAsset: base58,
  actor: base58,
  authority: z.enum(["owner", "delegate"]),
  action: z.enum(["create", "deposit", "trade", "delegate", "revoke", "transfer"]),
  rationale: z.string().optional(),
  riskDecision: z
    .object({
      allowed: z.boolean(),
      checks: z.array(
        z.object({
          code: z.string(),
          passed: z.boolean(),
          observed: z.union([z.string(), z.number()]).optional(),
          limit: z.union([z.string(), z.number()]).optional(),
          message: z.string(),
        }),
      ),
    })
    .optional(),
  signature: z.string().optional(),
  status: z.enum(["proposed", "submitted", "confirmed", "failed"]),
  timestamp: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type PortActivity = z.infer<typeof PortActivitySchema>;

/**
 * Price snapshot in integer fixed-point: price = priceE8 / 1e8 USD per whole token.
 * Confidence uses the same scale. `publishTime` is unix seconds.
 */
export type PriceSnapshot = {
  mint: string;
  symbol: string;
  priceE8: bigint;
  confE8: bigint;
  publishTime: number;
  source: string;
  /** Reference (underlying/benchmark) price in the same scale, when available. */
  referencePriceE8?: bigint;
  referenceConfE8?: bigint;
  referencePublishTime?: number;
  referenceSource?: string;
  /** Recent realized volatility, in bps, when available. */
  volatilityBps?: number;
  /** Market session for the reference instrument, when reliably known. */
  marketSession?: "open" | "closed" | "unknown";
};

export type Cluster = "localnet" | "devnet" | "mainnet-beta";

export function explorerTx(signature: string, cluster: Cluster, rpcUrl?: string): string {
  return explorerUrl(`tx/${signature}`, cluster, rpcUrl);
}
export function explorerAddress(address: string, cluster: Cluster, rpcUrl?: string): string {
  return explorerUrl(`address/${address}`, cluster, rpcUrl);
}
function explorerUrl(path: string, cluster: Cluster, rpcUrl?: string): string {
  const base = `https://explorer.solana.com/${path}`;
  if (cluster === "mainnet-beta") return base;
  if (cluster === "devnet") return `${base}?cluster=devnet`;
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl ?? "http://127.0.0.1:18899")}`;
}

/** Parse a decimal string ("12.34") into integer base units. Throws on excess precision. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`invalid amount "${amount}"`);
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) throw new Error(`"${amount}" exceeds ${decimals} decimals`);
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Format integer base units as a decimal string, trimming trailing zeros. */
export function fromBaseUnits(amount: bigint, decimals: number, maxFraction = decimals): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  let frac = (abs % unit).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export const usdE8 = (v: bigint, fractionDigits = 2) => `$${Number(fromBaseUnits(v, 8, fractionDigits)).toLocaleString("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`;

export const DISCLAIMER =
  "The agent token is a market for the autonomous operator and its community. It is not equity, a fund share, a security, or a claim on the PORT portfolio or its fees. PORT is hackathon software; nothing here is investment advice.";
