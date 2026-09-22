"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { RiskCheck } from "@port/shared";
import { explorer, short } from "@/lib/format";
import type { Wallet } from "@/lib/client";

export type IdentityKind = "wallet" | "owner" | "signer" | "agent";

const ID_META: Record<IdentityKind, { label: string; color: string; soft: string; glyph: string; help: string }> = {
  wallet: { label: "Connected wallet", color: "var(--wallet)", soft: "color-mix(in oklab, var(--wallet) 12%, var(--card))", glyph: "◉", help: "The browser wallet signing right now." },
  owner: { label: "Core owner", color: "var(--owner)", soft: "var(--owner-soft)", glyph: "◆", help: "Owns the PORT Core asset. Moves on transfer." },
  signer: { label: "Asset Signer", color: "var(--signer)", soft: "var(--signer-soft)", glyph: "⬢", help: "PDA derived from the asset. Holds every position. Never moves." },
  agent: { label: "Agent executive", color: "var(--agent)", soft: "var(--agent-soft)", glyph: "✦", help: "May Execute under delegation, within policy. Revocable." },
};

export function IdentityChip({ kind, address, env, compact }: { kind: IdentityKind; address: string | null; env?: { cluster: string; rpcUrl: string }; compact?: boolean }) {
  const m = ID_META[kind];
  const body = (
    <span
      title={`${m.label}: ${m.help}${address ? `\n${address}` : ""}`}
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[12px] leading-none"
      style={{ color: m.color, borderColor: `color-mix(in oklab, ${m.color} 35%, transparent)`, background: m.soft }}
    >
      <span aria-hidden>{m.glyph}</span>
      {!compact && <span className="font-sans text-[11px] font-semibold tracking-wide">{m.label}</span>}
      <span>{short(address, 4)}</span>
    </span>
  );
  return address && env ? (
    <a href={explorer("address", address, env.cluster, env.rpcUrl)} target="_blank" rel="noreferrer" className="hover:opacity-80">
      {body}
    </a>
  ) : (
    body
  );
}

export function IdentityLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {(Object.keys(ID_META) as IdentityKind[]).map((k) => (
        <span key={k} className="flex items-center gap-1.5 text-[11px] text-ink-3" title={ID_META[k].help}>
          <span style={{ color: ID_META[k].color }}>{ID_META[k].glyph}</span>
          {ID_META[k].label}
        </span>
      ))}
    </div>
  );
}

/** The Asset Signer drawn as an engraved seal: the fixed point of the whole product. */
export function Seal({ address, size = 132 }: { address: string; size?: number }) {
  const text = `ASSET SIGNER · ${address} · `;
  return (
    <svg width={size} height={size} viewBox="0 0 140 140" role="img" aria-label={`Asset Signer ${address}`}>
      <defs>
        <path id="seal-circle" d="M70,70 m-54,0 a54,54 0 1,1 108,0 a54,54 0 1,1 -108,0" />
      </defs>
      <circle cx="70" cy="70" r="66" fill="var(--signer-soft)" stroke="var(--signer)" strokeWidth="1.5" />
      <circle cx="70" cy="70" r="44" fill="none" stroke="var(--signer)" strokeWidth="0.8" strokeDasharray="2 3" />
      <g className="seal-ring">
        <text fontFamily="var(--font-mono)" fontSize="7.4" letterSpacing="1.6" fill="var(--signer)">
          <textPath href="#seal-circle">{text.repeat(2).slice(0, 118)}</textPath>
        </text>
      </g>
      <path d="M70 44 L92 57 L92 83 L70 96 L48 83 L48 57 Z" fill="none" stroke="var(--signer)" strokeWidth="2" />
      <text x="70" y="75" textAnchor="middle" fontFamily="var(--font-instrument)" fontSize="18" fill="var(--signer)" fontStyle="italic">
        vault
      </text>
    </svg>
  );
}

export function Checks({ checks, dense }: { checks: RiskCheck[]; dense?: boolean }) {
  return (
    <ul className={`grid gap-x-6 ${dense ? "gap-y-0.5" : "gap-y-1.5"} sm:grid-cols-2`}>
      {checks.map((c, i) => (
        <li key={`${c.code}-${i}`} className="flex items-start gap-2 text-[12px] leading-snug" title={c.message}>
          <span className="mt-[1px] font-mono font-bold" style={{ color: c.passed ? "var(--pass)" : "var(--fail)" }}>
            {c.passed ? "✓" : "✗"}
          </span>
          <span className="min-w-0">
            <span className="font-mono text-[11px] tracking-tight text-ink">{c.code}</span>
            {(c.observed !== undefined || c.limit !== undefined) && (
              <span className="ml-1.5 font-mono text-[11px] text-ink-3">
                {c.observed ?? "—"}
                {c.limit !== undefined ? ` / ${c.limit}` : ""}
              </span>
            )}
            {!dense && <span className="block text-ink-3">{c.message}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TxLink({ sig, env, label }: { sig?: string; env: { cluster: string; rpcUrl: string }; label?: string }) {
  if (!sig) return null;
  return (
    <a className="font-mono text-[11px] text-wallet underline decoration-dotted underline-offset-2 hover:opacity-75" href={explorer("tx", sig, env.cluster, env.rpcUrl)} target="_blank" rel="noreferrer">
      {label ?? `tx ${short(sig, 5)}`} ↗
    </a>
  );
}

export function Banner({ tone, children }: { tone: "fail" | "agent" | "info"; children: ReactNode }) {
  const c = tone === "fail" ? "var(--fail)" : tone === "agent" ? "var(--agent)" : "var(--wallet)";
  return (
    <div className="rounded-xl border px-4 py-3 text-[13px] leading-relaxed" style={{ borderColor: `color-mix(in oklab, ${c} 40%, transparent)`, background: `color-mix(in oklab, ${c} 9%, var(--card))`, color: "var(--ink)" }}>
      {children}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[color-mix(in_oklab,var(--ink)_45%,transparent)] p-3 backdrop-blur-[2px] sm:items-center" onClick={onClose}>
      <div className={`card rise max-h-[92dvh] w-full overflow-y-auto p-5 sm:p-7 ${wide ? "max-w-3xl" : "max-w-lg"}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="font-display text-3xl leading-none">{title}</h2>
          <button className="text-ink-3 hover:text-ink" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Shell({
  env,
  wallets,
  activeIndex,
  setActive,
  onFaucet,
  children,
}: {
  env: { cluster: string; rpcUrl: string; devPriceFallback: boolean; pythConfigured: boolean; faucet: boolean } | null;
  wallets: Wallet[];
  activeIndex: 0 | 1;
  setActive: (i: 0 | 1) => void;
  onFaucet?: () => Promise<void>;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const clusterLabel = env?.cluster === "fork" ? "Mainnet fork · local ledger" : env?.cluster ?? "…";
  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 pb-24 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-rule py-4">
        <Link href="/" className="flex items-baseline gap-3">
          <span className="font-display text-[34px] leading-none tracking-tight">PORT</span>
          <span className="hidden font-display text-lg italic text-ink-3 sm:inline">an investment account you can own</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded-full border px-2.5 py-1 font-mono text-[11px]"
            style={{ borderColor: "var(--rule-strong)", color: env?.cluster === "mainnet-beta" ? "var(--fail)" : "var(--ink-2)" }}
            title="Programs, mints and pools are cloned from Solana mainnet into a local validator. No real funds."
          >
            {clusterLabel}
          </span>
          <div className="flex overflow-hidden rounded-full border border-rule-strong" role="tablist" aria-label="Demo wallet">
            {wallets.map((w, i) => (
              <button
                key={w.label}
                role="tab"
                aria-selected={activeIndex === i}
                onClick={() => setActive(i as 0 | 1)}
                className="px-3 py-1.5 font-mono text-[11px] transition-colors"
                style={activeIndex === i ? { background: "var(--wallet)", color: "var(--paper)" } : { color: "var(--ink-2)" }}
                title={w.signer.publicKey}
              >
                {w.label.replace("Wallet ", "")} · {short(w.signer.publicKey, 3)}
              </button>
            ))}
          </div>
          {env?.faucet && onFaucet && (
            <button
              className="btn btn-ghost !py-1 !text-[12px]"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await onFaucet().finally(() => setBusy(false));
              }}
              title="Fork only: 5 SOL + 5,000 fork USDC from the demo treasury"
            >
              {busy ? "Funding…" : "Faucet"}
            </button>
          )}
        </div>
      </header>
      {env?.devPriceFallback && (
        <div className="mt-4">
          <Banner tone="fail">
            <b>DEV FALLBACK pricing.</b> No <code className="font-mono">PYTH_API_KEY</code> is configured, so USDC is priced at a fixed $1 and pre-IPO references use the PreStocks mark. Fork-only; live mode refuses to trade without Pyth.
          </Banner>
        </div>
      )}
      {env && !env.pythConfigured && !env.devPriceFallback && (
        <div className="mt-4">
          <Banner tone="agent">
            Pyth is not configured, so every trade fails closed. Set <code className="font-mono">PYTH_API_KEY</code> to enable execution.
          </Banner>
        </div>
      )}
      {children}
    </div>
  );
}
