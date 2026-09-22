"use client";
import { useEffect, useState } from "react";
import { DISCLAIMER } from "@port/shared";
import { api } from "@/lib/client";
import { short, units } from "@/lib/format";
import { TxLink } from "./ui";

type MarketDto = {
  market: null | {
    pool: string; baseMint: string; quoteMint: string; feeClaimer: string; signatures: Record<string, string>; stale?: string;
    state?: { quoteReserve: string; baseReserve: string; progressBps: number; migrationQuoteThreshold: string; creatorQuoteFee: string; partnerQuoteFee: string; isMigrated: boolean };
  };
  design: { name: string; symbol: string; quote: { symbol: string; decimals: number }; feeBps: number; percentageSupplyOnMigration: number; migrationQuoteThreshold: number; rationale: Record<string, string> };
  clawpump: { configured: boolean };
};

export function AgentMarket({ env }: { env: { cluster: string; rpcUrl: string } }) {
  const [m, setM] = useState<MarketDto | null>(null);
  useEffect(() => void api<MarketDto>("/api/market").then(setM).catch(() => {}), []);
  if (!m) return null;
  const { design: d, market } = m;
  const s = market?.state;
  return (
    <section className="card relative mt-6 overflow-hidden p-5 sm:p-6">
      <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: "linear-gradient(90deg, var(--agent), var(--signer))" }} />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-3xl">
          Agent market <span className="italic text-ink-3">· {d.symbol} / {d.quote.symbol}</span>
        </h2>
        <span className="text-[11px] text-ink-3">Meteora Dynamic Bonding Curve, quoted in a tokenized stock</span>
      </div>
      {!market && <p className="mt-3 text-sm text-ink-3">Not launched on this cluster yet. Run <code className="font-mono">pnpm demo:agent-market</code>.</p>}
      {market && (
        <div className="mt-4 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[12px] text-ink-2">
              <span>pool {short(market.pool, 5)}</span>
              <span>token {short(market.baseMint, 5)}</span>
              <span>fees → {short(market.feeClaimer, 4)} (agent treasury)</span>
            </div>
            {s ? (
              <>
                <div className="mt-4">
                  <div className="flex justify-between text-[12px] text-ink-3">
                    <span>raised {units(s.quoteReserve, d.quote.decimals, 4)} {d.quote.symbol}</span>
                    <span>graduates at {units(s.migrationQuoteThreshold, d.quote.decimals, 2)} {d.quote.symbol} → DAMM v2</span>
                  </div>
                  <div className="mt-1.5 h-3 overflow-hidden rounded-full bg-paper-2">
                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, s.progressBps / 100)}%`, background: "var(--agent)" }} />
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-ink-3">{(s.progressBps / 100).toFixed(2)}% of the curve{s.isMigrated ? " · migrated" : ""}</p>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-[13px]">
                  <div>
                    <dt className="eyebrow">Creator fees accrued</dt>
                    <dd className="num font-mono">{units(s.creatorQuoteFee, d.quote.decimals, 6)} {d.quote.symbol}</dd>
                  </div>
                  <div>
                    <dt className="eyebrow">Partner fees accrued</dt>
                    <dd className="num font-mono">{units(s.partnerQuoteFee, d.quote.decimals, 6)} {d.quote.symbol}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <p className="mt-3 text-[12px] text-fail">Pool state unavailable: {market.stale}</p>
            )}
            <div className="mt-4 flex flex-wrap gap-3">
              {Object.entries(market.signatures).map(([k, sig]) => (
                <TxLink key={k} sig={sig} env={env} label={k} />
              ))}
            </div>
            <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
              ClawPump: {m.clawpump.configured ? "API key configured" : "no API key configured"}. ClawPump’s published Solana launch path is pump.fun, so the stock-quoted
              Meteora market is created by PORT’s own DBC adapter; see README.
            </p>
          </div>
          <dl className="space-y-2.5 text-[12.5px] leading-relaxed">
            {Object.entries(d.rationale).map(([k, v]) => (
              <div key={k}>
                <dt className="eyebrow">{k}</dt>
                <dd className="text-ink-2">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <p className="mt-5 border-t border-rule pt-3 text-[11px] leading-relaxed text-ink-3">{DISCLAIMER}</p>
    </section>
  );
}
