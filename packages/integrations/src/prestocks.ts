import { z } from "zod";

/**
 * PreStocks mints verified on Solana mainnet (2026-09-22) against https://prestocks.com/api/prestocks.
 * All are Token-2022, 9 decimals, with transfer fee, scaled UI amount, pausable and permanent
 * delegate extensions controlled by the issuer. None exist on devnet.
 */
export const PRESTOCKS = [
  { symbol: "OPENAI", name: "OpenAI", mint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF", pythFeedId: "96d4bb23a3db78fdb72b3a03ce80ead686096f324319166534d9a27c0519c483" },
  { symbol: "ANTHROPIC", name: "Anthropic", mint: "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw", pythFeedId: "5da511a7c68b17a3bc94380cab4756bc83ab87f86307af10ea58467a64b6689d" },
  { symbol: "SPACEX", name: "SpaceX", mint: "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh", pythFeedId: null },
  { symbol: "ANDURIL", name: "Anduril", mint: "PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB", pythFeedId: null },
  { symbol: "FIGUREAI", name: "Figure AI", mint: "PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd", pythFeedId: null },
  { symbol: "KALSHI", name: "Kalshi", mint: "PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua", pythFeedId: null },
  { symbol: "NEURALINK", name: "Neuralink", mint: "PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S", pythFeedId: null },
  { symbol: "POLYMARKET", name: "Polymarket", mint: "Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP", pythFeedId: null },
] as const;

export type PreStockSymbol = (typeof PRESTOCKS)[number]["symbol"];
export const PRESTOCK_MINTS: readonly string[] = PRESTOCKS.map((p) => p.mint);

const ApiRow = z.object({
  symbol: z.string(),
  contract_address: z.string(),
  markPrice: z.number().positive(),
  tokenPrice: z.number().positive(),
  markValuation: z.number().optional(),
  impliedValuation: z.number().optional(),
  supply: z.number().optional(),
});
export type PreStocksQuote = z.infer<typeof ApiRow>;

/** Public catalog/mark API. Rows for mints outside the verified list are dropped. */
export async function fetchPreStocksCatalog(fetcher: typeof fetch = fetch): Promise<Map<string, PreStocksQuote>> {
  const res = await fetcher("https://prestocks.com/api/prestocks", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`PreStocks API unavailable (${res.status})`);
  const rows = z.array(ApiRow.passthrough()).parse(await res.json());
  return new Map(rows.filter((r) => PRESTOCK_MINTS.includes(r.contract_address)).map((r) => [r.contract_address, r]));
}

const MintExtensions = z.object({
  decimals: z.number(),
  extensions: z.array(z.object({ extension: z.string(), state: z.record(z.string(), z.unknown()) })).default([]),
});

export type Token2022Profile = {
  decimals: number;
  /** Raw→UI multiplier, as a fixed-point E9 integer, currently in effect. */
  uiMultiplierE9: bigint;
  transferFeeBps: number;
  paused: boolean;
  permanentDelegate: string | null;
};

/**
 * Reads the Token-2022 extensions that change PORT's math and risk: scaled UI multiplier,
 * epoch-scheduled transfer fee, pause state and permanent delegate.
 */
export async function fetchToken2022Profile(rpcUrl: string, mint: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<Token2022Profile> {
  const call = async (method: string, params: unknown[]) => {
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = (await r.json()) as { result: any; error?: unknown };
    if (j.error) throw new Error(`${method} failed: ${JSON.stringify(j.error)}`);
    return j.result;
  };
  const [acct, epochInfo] = await Promise.all([call("getAccountInfo", [mint, { encoding: "jsonParsed" }]), call("getEpochInfo", [])]);
  const info = MintExtensions.parse(acct?.value?.data?.parsed?.info);
  const ext = (name: string) => info.extensions.find((e) => e.extension === name)?.state as Record<string, any> | undefined;

  const scaled = ext("scaledUiAmountConfig");
  let multiplier = "1";
  if (scaled) multiplier = nowSeconds >= Number(scaled.newMultiplierEffectiveTimestamp ?? 0) ? String(scaled.newMultiplier) : String(scaled.multiplier);

  const fee = ext("transferFeeConfig");
  let transferFeeBps = 0;
  if (fee) transferFeeBps = epochInfo.epoch >= Number(fee.newerTransferFee?.epoch ?? 0) ? Number(fee.newerTransferFee.transferFeeBasisPoints) : Number(fee.olderTransferFee.transferFeeBasisPoints);

  return {
    decimals: info.decimals,
    uiMultiplierE9: decimalToE9(multiplier),
    transferFeeBps,
    paused: Boolean(ext("pausableConfig")?.paused),
    permanentDelegate: (ext("permanentDelegate")?.delegate as string | undefined) ?? null,
  };
}

/** "1.4861347" → 1486134700n. Rejects more than 9 fractional digits rather than rounding. */
export function decimalToE9(s: string): bigint {
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error(`unsupported multiplier ${s}`);
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * 1_000_000_000n + BigInt(f.padEnd(9, "0"));
}

/** Convert a USD price per UI token (float from an API) to E8 per raw whole token. */
export function uiPriceToRawE8(uiPriceUsd: number, uiMultiplierE9: bigint): bigint {
  const uiE8 = BigInt(Math.round(uiPriceUsd * 1e8));
  return (uiE8 * uiMultiplierE9) / 1_000_000_000n;
}
