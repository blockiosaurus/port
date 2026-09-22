import { z } from "zod";
import type { PortStrategy, PriceSnapshot } from "@port/shared";
import { JupiterTradeAdapter } from "./jupiter";
import { PRESTOCKS, fetchPreStocksCatalog, uiPriceToRawE8, type Token2022Profile } from "./prestocks";

export const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const PYTH_USDC_USD = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";

const PythPrice = z.object({ price: z.string(), conf: z.string(), expo: z.number(), publish_time: z.number() });
const HermesLatest = z.object({
  parsed: z.array(z.object({ id: z.string(), price: PythPrice, ema_price: PythPrice })),
});
const FeedMeta = z.array(
  z.object({ id: z.string(), market_hours: z.object({ is_open: z.boolean() }).nullable().optional(), attributes: z.record(z.string(), z.string()) }),
);

export type PythQuote = { id: string; priceE8: bigint; confE8: bigint; emaE8: bigint; publishTime: number; isOpen?: boolean };

/** Rescale a Pyth integer (value × 10^expo) to 1e8 fixed point without floats. */
export function pythToE8(value: string, expo: number): bigint {
  const v = BigInt(value);
  const shift = expo + 8;
  return shift >= 0 ? v * 10n ** BigInt(shift) : v / 10n ** BigInt(-shift);
}

export class PythHermesClient {
  constructor(
    private readonly apiKey: string | undefined = process.env.PYTH_API_KEY,
    private readonly baseUrl = process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  get configured() {
    return Boolean(this.apiKey);
  }

  /** Feeds the key is not entitled to (e.g. gated `pyth-indices`), with Hermes' reason. */
  readonly unavailable = new Map<string, string>();

  /**
   * Latest parsed prices. Hermes requires an API key (since 2026-08) and rejects a whole batch
   * if any feed is gated, so each feed is requested on its own; unentitled feeds are recorded
   * in `unavailable` and simply absent from the result (the risk engine then fails closed).
   */
  async latest(ids: string[]): Promise<Map<string, PythQuote>> {
    if (!this.apiKey) throw new Error("PYTH_API_KEY is not set; Pyth price updates require an API key");
    const results = await Promise.all(ids.map((id) => this.latestBatch([id]).catch((e: Error) => (this.unavailable.set(id, e.message), new Map<string, PythQuote>()))));
    const out = new Map<string, PythQuote>();
    for (const r of results) for (const [k, v] of r) out.set(k, v);
    if (out.size === 0 && this.unavailable.size) throw new Error([...this.unavailable.values()][0]);
    return out;
  }

  private async latestBatch(ids: string[]): Promise<Map<string, PythQuote>> {
    const url = new URL(`${this.baseUrl}/v2/updates/price/latest`);
    for (const id of ids) url.searchParams.append("ids[]", id);
    url.searchParams.set("parsed", "true");
    const res = await this.fetcher(url, { headers: { authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) throw new Error(`Pyth Hermes ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const body = HermesLatest.parse(await res.json());
    const hours = await this.marketHoursCached(ids);
    return new Map(
      body.parsed.map((p) => [
        p.id,
        {
          id: p.id,
          priceE8: pythToE8(p.price.price, p.price.expo),
          confE8: pythToE8(p.price.conf, p.price.expo),
          emaE8: pythToE8(p.ema_price.price, p.ema_price.expo),
          publishTime: p.price.publish_time,
          isOpen: hours.get(p.id),
        },
      ]),
    );
  }

  private hoursCache: { at: number; map: Map<string, boolean> } | null = null;
  private async marketHoursCached(ids: string[]) {
    if (!this.hoursCache || Date.now() - this.hoursCache.at > 60_000)
      this.hoursCache = { at: Date.now(), map: await this.marketHours(ids).catch(() => new Map<string, boolean>()) };
    return this.hoursCache.map;
  }

  /** Market-hours metadata; this endpoint does not require a key. */
  async marketHours(ids: string[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    for (const assetType of ["equity", "crypto"]) {
      const res = await this.fetcher(`${this.baseUrl}/v2/price_feeds?asset_type=${assetType}`);
      if (!res.ok) continue;
      for (const f of FeedMeta.parse(await res.json())) if (ids.includes(f.id) && f.market_hours) out.set(f.id, f.market_hours.is_open);
    }
    return out;
  }
}

export type MarketProbe = { bidE8: bigint; askE8: bigint };

/**
 * Executable market price for a token vs USDC from two Jupiter quotes (buy and sell of ~`sizeUsd`),
 * expressed per raw whole token in 1e8 USD. Uses gross (pre transfer-fee) amounts; fees are
 * charged separately in execution checks.
 */
const probeCache = new Map<string, MarketProbe & { at: number }>();
const inflight = new Map<string, Promise<MarketProbe & { at: number }>>();

/** Cached for `ttlSeconds`; `at` is the true fetch time and becomes the snapshot publish time. */
export async function probeJupiterMarketCached(jup: JupiterTradeAdapter, mint: string, decimals: number, ttlSeconds = 30): Promise<MarketProbe & { at: number }> {
  const hit = probeCache.get(mint);
  const now = Math.floor(Date.now() / 1000);
  if (hit && now - hit.at <= ttlSeconds) return hit;
  // Concurrent snapshot requests share one probe instead of queueing duplicate quotes.
  const pending = inflight.get(mint);
  if (pending) return pending;
  const p = probeJupiterMarket(jup, mint, decimals)
    .then((m) => {
      const fresh = { ...m, at: Math.floor(Date.now() / 1000) };
      probeCache.set(mint, fresh);
      return fresh;
    })
    .finally(() => inflight.delete(mint));
  inflight.set(mint, p);
  return p;
}

export async function probeJupiterMarket(jup: JupiterTradeAdapter, mint: string, decimals: number, sizeUsd = 100): Promise<MarketProbe> {
  const usdcIn = BigInt(sizeUsd) * 1_000_000n;
  const buy = await jup.quote({ inputMint: USDC_MAINNET, outputMint: mint, amountIn: usdcIn, slippageBps: 100 });
  const tokensOut = BigInt(buy.raw.outAmount);
  if (tokensOut === 0n) throw new Error("no liquidity");
  const askE8 = (usdcIn * 100n * 10n ** BigInt(decimals)) / tokensOut; // USDC(6dp)→E8 is ×100
  const sell = await jup.quote({ inputMint: mint, outputMint: USDC_MAINNET, amountIn: tokensOut, slippageBps: 100 });
  const bidE8 = (BigInt(sell.raw.outAmount) * 100n * 10n ** BigInt(decimals)) / tokensOut;
  return { bidE8, askE8 };
}

export type PricingSources = {
  pyth: PythHermesClient;
  jupiter: JupiterTradeAdapter;
  /** Token-2022 profiles for PreStocks mints (multiplier, fee), keyed by mint. */
  profiles: ReadonlyMap<string, Token2022Profile>;
  now?: () => number;
  /**
   * Local fork/localnet only: when Pyth is unreachable, price USDC at a fixed $1 and use the
   * PreStocks mark as reference. Every snapshot is labeled DEV FALLBACK and the UI warns loudly.
   */
  devFallback?: boolean;
};

export const DEV_FALLBACK_LABEL = "DEV FALLBACK (no Pyth key)";

export type PricingReport = {
  prices: Map<string, PriceSnapshot>;
  /** Human-readable reasons a source was unavailable; surfaced in the UI. */
  warnings: string[];
};

/**
 * Builds validated snapshots for every strategy mint. Cash is priced by Pyth USDC/USD only.
 * PreStocks are priced at the Jupiter mid (spread → confidence) with the Pyth index as reference
 * when a feed exists, falling back to the PreStocks API mark (labeled) otherwise.
 * Any missing source yields no snapshot, so the risk engine fails closed.
 */
export async function buildPriceSnapshots(strategy: PortStrategy, src: PricingSources): Promise<PricingReport> {
  const now = src.now?.() ?? Math.floor(Date.now() / 1000);
  const warnings: string[] = [];
  const prices = new Map<string, PriceSnapshot>();
  const pre = strategy.targets.map((t) => ({ t, meta: PRESTOCKS.find((p) => p.mint === t.mint) }));

  const feedIds = [PYTH_USDC_USD, ...pre.flatMap((x) => (x.meta?.pythFeedId ? [x.meta.pythFeedId] : []))];
  let pyth = new Map<string, PythQuote>();
  try {
    pyth = await src.pyth.latest(feedIds);
  } catch (e) {
    warnings.push(`Pyth unavailable: ${(e as Error).message}`);
  }
  for (const [id, why] of src.pyth.unavailable) {
    const sym = id === PYTH_USDC_USD ? "USDC/USD" : (pre.find((x) => x.meta?.pythFeedId === id)?.t.symbol ?? id.slice(0, 8));
    warnings.push(`Pyth ${sym} feed unavailable to this API key: ${why.replace(/^Pyth Hermes \d+: /, "").slice(0, 120)}`);
  }
  const catalog = await fetchPreStocksCatalog().catch((e) => {
    warnings.push(`PreStocks API unavailable: ${(e as Error).message}`);
    return new Map();
  });

  const usdc = pyth.get(PYTH_USDC_USD);
  const fallback = src.devFallback === true && pyth.size === 0;
  if (fallback) {
    warnings.push("Pyth prices unavailable: using DEV FALLBACK prices. Never use this mode with real funds.");
    prices.set(strategy.cashMint, { mint: strategy.cashMint, symbol: "USDC", priceE8: 100_000_000n, confE8: 0n, publishTime: now, source: `${DEV_FALLBACK_LABEL}: $1.00` });
  }
  if (usdc)
    prices.set(strategy.cashMint, {
      mint: strategy.cashMint, symbol: "USDC", priceE8: usdc.priceE8, confE8: usdc.confE8, publishTime: usdc.publishTime, source: "Pyth USDC/USD",
      volatilityBps: emaDeviationBps(usdc),
    });

  await Promise.all(
    pre.map(async ({ t, meta }) => {
      if (t.mint === strategy.cashMint) return;
      const profile = src.profiles.get(t.mint);
      if (!meta || !profile) return warnings.push(`${t.symbol}: not a verified PreStocks mint`);
      if (profile.paused) return warnings.push(`${t.symbol}: issuer has paused transfers`);
      let probe: MarketProbe & { at: number };
      try {
        probe = await probeJupiterMarketCached(src.jupiter, t.mint, profile.decimals);
      } catch (e) {
        return warnings.push(`${t.symbol}: no executable market (${(e as Error).message})`);
      }
      const mid = (probe.bidE8 + probe.askE8) / 2n;
      const snap: PriceSnapshot = { mint: t.mint, symbol: t.symbol, priceE8: mid, confE8: (probe.askE8 - probe.bidE8) / 2n, publishTime: probe.at, source: "Jupiter bid/ask mid" };
      const feed = meta.pythFeedId ? pyth.get(meta.pythFeedId) : undefined;
      if (feed) {
        // Pyth index is per share-equivalent (one UI token); convert to per raw token.
        snap.referencePriceE8 = (feed.priceE8 * profile.uiMultiplierE9) / 1_000_000_000n;
        snap.referenceConfE8 = (feed.confE8 * profile.uiMultiplierE9) / 1_000_000_000n;
        snap.referencePublishTime = feed.publishTime;
        snap.referenceSource = `Pyth ${t.symbol} index`;
        snap.volatilityBps = emaDeviationBps(feed);
        snap.marketSession = feed.isOpen === undefined ? "unknown" : feed.isOpen ? "open" : "closed";
      } else {
        const row = catalog.get(t.mint);
        if (row) {
          snap.referencePriceE8 = uiPriceToRawE8(row.markPrice, profile.uiMultiplierE9);
          snap.referencePublishTime = now;
          snap.referenceSource = !meta.pythFeedId
            ? "PreStocks mark (no Pyth feed)"
            : fallback
              ? `${DEV_FALLBACK_LABEL}: PreStocks mark`
              : "PreStocks mark (Pyth index not entitled)";
        }
      }
      prices.set(t.mint, snap);
    }),
  );
  return { prices, warnings };
}

/** Short-horizon volatility proxy: |price − EMA| / EMA, in bps. */
function emaDeviationBps(q: PythQuote): number {
  if (q.emaE8 <= 0n) return 0;
  const d = q.priceE8 > q.emaE8 ? q.priceE8 - q.emaE8 : q.emaE8 - q.priceE8;
  return Number((d * 10_000n) / q.emaE8);
}
