"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PortActivity } from "@port/shared";
import { DISCLAIMER } from "@port/shared";
import {
  actionDelegate, actionDeposit, actionRevoke, actionTrade, actionTransfer, api, faucet, rememberPort, umiFor, useWallets, type Wallet,
} from "@/lib/client";
import type { PortViewDto, ProposalDto, SnapshotDto, TradeDto } from "@/lib/dto";
import { ago, pct, short, units, usd } from "@/lib/format";
import { Banner, Checks, IdentityChip, Modal, Seal, Shell, TxLink } from "@/components/ui";
import { AgentMarket } from "@/components/AgentMarket";

type Env = PortViewDto["env"];
type TransferProof = { before: SnapshotDto; after: SnapshotDto; signature: string; from: string; to: string };

export default function Dashboard({ asset }: { asset: string }) {
  const { wallets, active, activeIndex, setActive } = useWallets();
  const [view, setView] = useState<PortViewDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: "fail" | "info"; text: string; sig?: string } | null>(null);
  const [review, setReview] = useState<{ proposal: ProposalDto; by: "owner" | "agent" } | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [tradeOpen, setTradeOpen] = useState(false);
  const [proof, setProof] = useState<TransferProof | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await api<PortViewDto>(`/api/port/${asset}`));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [asset]);

  useEffect(() => {
    rememberPort(asset);
    void refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [asset, refresh]);

  const env = view?.env ?? null;
  const snap = view?.snapshot;
  const isOwner = !!active && !!snap && active.signer.publicKey === snap.port.owner;
  const executive = env?.executive ?? null;
  const agentDelegated = !!snap && !!executive && snap.delegates.some((d) => d.executiveAuthority === executive);
  const inheritedDelegates = useMemo(() => {
    if (!view || !snap?.delegates.length) return false;
    const lastTransfer = view.activity.find((a) => a.action === "transfer" && a.status === "confirmed");
    const lastDelegate = view.activity.find((a) => a.action === "delegate" && a.status === "confirmed");
    return !!lastTransfer && (!lastDelegate || lastDelegate.timestamp < lastTransfer.timestamp);
  }, [view, snap]);

  async function run<T>(label: string, fn: () => Promise<T>, ok?: (r: T) => string | { text: string; sig?: string }) {
    setBusy(label);
    setToast(null);
    try {
      const r = await fn();
      if (ok) {
        const m = ok(r);
        setToast(typeof m === "string" ? { tone: "info", text: m } : { tone: "info", ...m });
      }
      await refresh();
      return r;
    } catch (e) {
      const err = e as Error & { code?: string };
      setToast({ tone: "fail", text: err.code === "NOT_AUTHORIZED" ? "Rejected on-chain: this wallet is neither the owner nor an active delegate." : err.message });
    } finally {
      setBusy(null);
    }
  }

  const umi = env && active ? umiFor(env.rpcUrl, active) : null;
  const other = wallets.find((w) => w.signer.publicKey !== active?.signer.publicKey);

  return (
    <Shell
      env={env}
      wallets={wallets}
      activeIndex={activeIndex}
      setActive={setActive}
      onFaucet={env && active ? async () => void (await run("faucet", () => faucet(env, active), () => `Funded ${active.label} with 5 SOL + 5,000 fork USDC`)) : undefined}
    >
      {loadError && !view && (
        <div className="mt-8">
          <Banner tone="fail">Could not load PORT {short(asset, 6)}: {loadError}</Banner>
        </div>
      )}
      {!view && !loadError && <p className="mt-16 font-display text-3xl italic text-ink-3">Reading the deed…</p>}

      {view && snap && env && (
        <>
          <Deed
            snap={snap}
            env={env}
            active={active}
            isOwner={isOwner}
            busy={busy}
            onDeposit={() => setDepositOpen(true)}
            onRebalance={() =>
              run("plan", () => api<ProposalDto>("/api/trade/prepare", { kind: "rebalance", asset, authority: active!.signer.publicKey }), (p) => {
                setReview({ proposal: p, by: "owner" });
                return p.plan.rationale;
              })
            }
            onTrade={() => setTradeOpen(true)}
            onTransfer={() => setTransferOpen(true)}
          />

          {inheritedDelegates && (
            <div className="mt-4">
              <Banner tone="agent">
                <b>Inherited execution delegate.</b> MPL Agent delegations persist across Core transfers: the agent below was authorised by a previous owner and can still Execute
                within policy.{" "}
                {isOwner ? "Review it, and revoke if you did not intend to keep it." : "Only the current owner can revoke it."}
              </Banner>
            </div>
          )}
          {toast && (
            <div className="mt-4">
              <Banner tone={toast.tone === "fail" ? "fail" : "info"}>
                {toast.text} {toast.sig && <TxLink sig={toast.sig} env={env} />}
              </Banner>
            </div>
          )}

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.65fr_1fr]">
            <Positions snap={snap} />
            <AgentPanel
              snap={snap}
              env={env}
              isOwner={isOwner}
              agentDelegated={agentDelegated}
              busy={busy}
              onDelegate={() => run("delegate", () => actionDelegate(umi!, active!, asset, executive!), (t) => ({ text: "Agent executive may now Execute within policy.", sig: t.signature }))}
              onRevoke={(exec) => run("revoke", () => actionRevoke(umi!, active!, asset, exec), (t) => ({ text: "Delegation revoked. The agent can no longer Execute.", sig: t.signature }))}
              onRun={(dryRun) =>
                run(dryRun ? "agent-plan" : "agent", () => api<ProposalDto & { results: PortActivity[] }>("/api/agent/run", { asset, dryRun }), (r) => {
                  setReview({ proposal: r, by: "agent" });
                  const done = r.results.filter((x) => x.status === "confirmed").length;
                  return dryRun ? r.plan.rationale : `Agent executed ${done} trade(s) via delegated Core Execute.`;
                })
              }
            />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.65fr_1fr]">
            <Pricing snap={snap} />
            <Mandate snap={snap} />
          </div>

          <Activity activity={view.activity} env={env} snap={snap} />

          <AgentMarket env={env} />

          <p className="mt-10 max-w-3xl text-[11px] leading-relaxed text-ink-3">{DISCLAIMER}</p>
        </>
      )}

      {review && env && (
        <ReviewModal
          review={review}
          env={env}
          isOwner={isOwner}
          busy={busy}
          onClose={() => setReview(null)}
          onExecute={async (trades) => {
            for (const t of trades) {
              const r = await run(`trade-${t.trade.symbol}`, () => actionTrade(umi!, active!, asset, t), (x) => ({ text: `${t.trade.side} ${t.trade.symbol} confirmed through Core Execute.`, sig: x.signature }));
              if (!r) return;
            }
            setReview(null);
          }}
        />
      )}

      <Modal open={depositOpen} onClose={() => setDepositOpen(false)} title="Deposit USDC">
        <DepositForm
          busy={busy === "deposit"}
          onSubmit={async (n) => {
            const r = await run("deposit", () => actionDeposit(umi!, active!, asset, n), (t) => ({ text: `Deposited ${n.toLocaleString()} USDC into the Asset Signer.`, sig: t.signature }));
            if (r) setDepositOpen(false);
          }}
        />
      </Modal>

      <Modal open={tradeOpen} onClose={() => setTradeOpen(false)} title="Place a trade">
        {snap && (
          <TradeForm
            snap={snap}
            busy={busy === "manual"}
            onSubmit={async (req) => {
              const p = await run("manual", () => api<ProposalDto>("/api/trade/prepare", { kind: "manual", asset, authority: active!.signer.publicKey, ...req }));
              if (p) {
                setTradeOpen(false);
                setReview({ proposal: p, by: "owner" });
              }
            }}
          />
        )}
      </Modal>

      <Modal open={transferOpen} onClose={() => setTransferOpen(false)} title="Transfer this PORT" wide>
        {snap && active && (
          <TransferForm
            snap={snap}
            from={active}
            suggested={other}
            busy={busy === "transfer"}
            onSubmit={async (to) => {
              const before = snap;
              const r = await run("transfer", () => actionTransfer(umi!, active, asset, to, { navE8: before.valuation.navE8 }));
              if (!r) return;
              const after = await api<PortViewDto>(`/api/port/${asset}`);
              setTransferOpen(false);
              setProof({ before, after: after.snapshot, signature: r.signature, from: active.signer.publicKey, to });
            }}
          />
        )}
      </Modal>

      {proof && env && (
        <TransferProofModal
          proof={proof}
          env={env}
          wallets={wallets}
          onSwitch={(i) => {
            setActive(i);
            setProof(null);
          }}
          onClose={() => setProof(null)}
        />
      )}
    </Shell>
  );
}

/* ---------------------------------------------------------------- deed */

function Deed({ snap, env, active, isOwner, busy, onDeposit, onRebalance, onTrade, onTransfer }: {
  snap: SnapshotDto; env: Env; active?: Wallet; isOwner: boolean; busy: string | null;
  onDeposit: () => void; onRebalance: () => void; onTrade: () => void; onTransfer: () => void;
}) {
  const nav = snap.valuation.navE8;
  return (
    <section className="card rise relative mt-8 overflow-hidden p-6 sm:p-8">
      <div aria-hidden className="pointer-events-none absolute -right-10 -top-10 font-display text-[220px] leading-none text-rule opacity-40 select-none">§</div>
      <div className="relative grid gap-8 md:grid-cols-[1fr_auto]">
        <div>
          <p className="eyebrow">PORT · Metaplex Core asset</p>
          <h1 className="mt-2 font-display text-[clamp(2.2rem,5vw,3.8rem)] leading-[0.95]">{snap.port.name}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[12px] text-ink-3">
            <a className="hover:text-ink" href={`https://explorer.solana.com/address/${snap.port.asset}?cluster=custom&customUrl=${encodeURIComponent(env.rpcUrl)}`} target="_blank" rel="noreferrer">
              asset {short(snap.port.asset, 6)} ↗
            </a>
            <span>·</span>
            <span title="Update authority renounced at creation: the original creator keeps no control after a sale.">update authority: {snap.port.updateAuthority === "None" ? "none (sealed)" : short(snap.port.updateAuthority)}</span>
            <span>·</span>
            <span>agent identity {snap.port.agentIdentity ? "registered" : "missing"}</span>
          </div>

          <dl className="mt-7 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="eyebrow mb-1.5">Owned by</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <IdentityChip kind="owner" address={snap.port.owner} env={env} />
                {active && (isOwner ? <span className="text-[12px] font-semibold text-owner">that’s you</span> : <span className="text-[12px] text-ink-3">not the connected wallet</span>)}
              </dd>
            </div>
            <div>
              <dt className="eyebrow mb-1.5">Positions held by</dt>
              <dd>
                <IdentityChip kind="signer" address={snap.port.signer} env={env} />
              </dd>
            </div>
            <div>
              <dt className="eyebrow mb-1.5">Connected</dt>
              <dd>{active ? <IdentityChip kind="wallet" address={active.signer.publicKey} env={env} /> : "—"}</dd>
            </div>
            <div>
              <dt className="eyebrow mb-1.5">May execute under delegation</dt>
              <dd className="flex flex-wrap gap-2">
                {snap.delegates.length ? snap.delegates.map((d) => <IdentityChip key={d.record} kind="agent" address={d.executiveAuthority} env={env} />) : <span className="text-[13px] text-ink-3">no one</span>}
              </dd>
            </div>
          </dl>
        </div>

        <div className="flex flex-col items-center justify-between gap-4 md:items-end">
          <Seal address={snap.port.signer} />
          <div className="text-center md:text-right">
            <p className="eyebrow">Net asset value</p>
            <p className="num font-display text-5xl leading-none">{snap.valuation.unpriced.length ? "—" : usd(nav)}</p>
            <p className="mt-1 text-[11px] text-ink-3">marked to executable mid · {ago(Math.floor(snap.fetchedAt / 1000))}</p>
          </div>
        </div>
      </div>

      <div className="relative mt-7 flex flex-wrap items-center gap-2 border-t border-rule pt-5">
        <button className="btn btn-ghost" disabled={!isOwner || !!busy} onClick={onDeposit} title="Deposit USDC into the Asset Signer">
          Deposit
        </button>
        <button className="btn" disabled={!isOwner || !!busy} onClick={onRebalance}>
          {busy === "plan" ? "Planning…" : "Rebalance"}
        </button>
        <button className="btn btn-ghost" disabled={!isOwner || !!busy} onClick={onTrade}>
          Trade
        </button>
        <span className="flex-1" />
        <button className="btn btn-owner" disabled={!isOwner || !!busy} onClick={onTransfer}>
          Transfer PORT →
        </button>
        {!isOwner && <span className="w-full text-[12px] text-ink-3">Owner actions are disabled: the connected wallet does not own this PORT. Execute would be rejected on-chain.</span>}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- positions */

function Positions({ snap }: { snap: SnapshotDto }) {
  return (
    <section className="card p-5 sm:p-6">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-3xl">Positions</h2>
        <span className="text-[11px] text-ink-3">every token account owned by the Asset Signer</span>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="eyebrow text-left">
              <th className="pb-2 font-normal">Asset</th>
              <th className="pb-2 text-right font-normal">Holding</th>
              <th className="pb-2 text-right font-normal">Value</th>
              <th className="w-[38%] pb-2 pl-6 font-normal">Weight vs target</th>
            </tr>
          </thead>
          <tbody>
            {snap.valuation.positions.map((p) => {
              const bal = snap.balances.find((b) => b.mint === p.mint);
              const prof = snap.profiles[p.mint];
              const mult = prof ? Number(prof.uiMultiplierE9) / 1e9 : 1;
              const uiAmount = bal ? (Number(units(bal.amount, bal.decimals, 6).replace(/,/g, "")) * mult).toLocaleString("en-US", { maximumFractionDigits: 4 }) : "0";
              const drift = Math.abs(p.driftBps) > snap.port.strategy.rebalanceToleranceBps;
              return (
                <tr key={p.mint} className="border-t border-rule">
                  <td className="py-3">
                    <div className="font-semibold">{p.symbol}</div>
                    <div className="font-mono text-[10.5px] text-ink-3">{bal?.tokenAccountOwner ? `acct ${short(bal.tokenAccount)} · owner ⬢ ${short(bal.tokenAccountOwner)}` : "no token account yet"}</div>
                  </td>
                  <td className="num py-3 text-right font-mono text-[13px]">{uiAmount}</td>
                  <td className="num py-3 text-right font-mono text-[13px]">{usd(p.valueE8)}</td>
                  <td className="py-3 pl-6">
                    <div className="relative h-2.5 rounded-full bg-paper-2">
                      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, p.weightBps / 100)}%`, background: drift ? "var(--owner)" : "var(--signer)" }} />
                      <div className="absolute -top-1 h-4.5 w-[2px] bg-ink" style={{ left: `${p.targetBps / 100}%` }} title={`target ${pct(p.targetBps)}`} />
                    </div>
                    <div className="mt-1 flex justify-between font-mono text-[10.5px] text-ink-3">
                      <span>{pct(p.weightBps)}</span>
                      <span style={{ color: drift ? "var(--owner)" : undefined }}>
                        {p.driftBps >= 0 ? "+" : ""}
                        {pct(p.driftBps)} vs {pct(p.targetBps, 0)}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- pricing */

function Pricing({ snap }: { snap: SnapshotDto }) {
  const now = Math.floor(Date.now() / 1000);
  const s = snap.port.strategy;
  return (
    <section className="card p-5 sm:p-6">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-3xl">Prices & risk inputs</h2>
        <span className="text-[11px] text-ink-3">these numbers permit or block every trade</span>
      </div>
      {snap.warnings.length > 0 && (
        <ul className="mt-3 space-y-1 text-[12px] text-fail">
          {snap.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-[12.5px]">
          <thead>
            <tr className="eyebrow text-left">
              <th className="pb-2 font-normal">Asset</th>
              <th className="pb-2 font-normal">Price source</th>
              <th className="pb-2 text-right font-normal">Age</th>
              <th className="pb-2 text-right font-normal">Half-spread</th>
              <th className="pb-2 font-normal pl-4">Reference</th>
              <th className="pb-2 text-right font-normal">Deviation / band</th>
            </tr>
          </thead>
          <tbody>
            {s.targets.map((t) => {
              const p = snap.prices[t.mint];
              if (!p)
                return (
                  <tr key={t.mint} className="border-t border-rule">
                    <td className="py-2.5 font-semibold">{t.symbol}</td>
                    <td className="py-2.5 text-fail" colSpan={5}>
                      no validated price: trades fail closed
                    </td>
                  </tr>
                );
              const age = now - p.publishTime;
              const conf = Number((BigInt(p.confE8) * 10000n) / (BigInt(p.priceE8) || 1n));
              const dev = p.referencePriceE8 ? Math.round(Math.abs(Number(p.priceE8) / Number(p.referencePriceE8) - 1) * 10000) : null;
              const band = t.maxReferenceDeviationBps ?? s.maxSpreadBps;
              const fallback = /FALLBACK/.test(p.source + (p.referenceSource ?? ""));
              return (
                <tr key={t.mint} className="border-t border-rule">
                  <td className="py-2.5 font-semibold">{t.symbol}</td>
                  <td className="py-2.5" style={{ color: fallback ? "var(--fail)" : undefined }}>
                    {p.source}
                  </td>
                  <td className="num py-2.5 text-right font-mono" style={{ color: age > s.maxPriceAgeSeconds ? "var(--fail)" : "var(--pass)" }}>
                    {age}s
                  </td>
                  <td className="num py-2.5 text-right font-mono" style={{ color: conf > s.maxSpreadBps ? "var(--fail)" : undefined }}>
                    {conf}bps
                  </td>
                  <td className="py-2.5 pl-4" style={{ color: /FALLBACK/.test(p.referenceSource ?? "") ? "var(--fail)" : undefined }}>
                    {p.referenceSource ?? (t.mint === s.cashMint ? "—" : "none")}
                    {p.marketSession && <span className="ml-1 text-ink-3">· {p.marketSession}</span>}
                  </td>
                  <td className="num py-2.5 text-right font-mono" style={{ color: dev !== null && dev > band ? "var(--fail)" : undefined }}>
                    {dev === null ? "—" : `${pct(dev)} / ${pct(band, 0)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
        PreStocks are marked at the Jupiter bid/ask mid for the exact pool the Asset Signer would trade; half-spread is the confidence band. Pyth supplies USDC/USD and the OpenAI and
        Anthropic reference indices (with market hours); names without a Pyth feed use the PreStocks mark. Every Token-2022 transfer loses {snap.profiles[s.targets[0]!.mint]?.transferFeeBps ?? 100}bps to
        the issuer fee, priced into each quote.
      </p>
    </section>
  );
}

function Mandate({ snap }: { snap: SnapshotDto }) {
  const s = snap.port.strategy;
  const rows: Array<[string, string]> = [
    ["Rebalance tolerance", `±${pct(s.rebalanceToleranceBps, 0)}`],
    ["Max trade", `${pct(s.maxTradeNavBps, 0)} of NAV`],
    ["Daily notional cap", s.maxDailyNotionalBps ? `${pct(s.maxDailyNotionalBps, 0)} of NAV` : "—"],
    ["Cash floor", pct(s.minCashWeightBps, 0)],
    ["Max position", pct(s.maxPositionWeightBps, 0)],
    ["Max price age", `${s.maxPriceAgeSeconds}s`],
    ["Max spread / confidence", `${s.maxSpreadBps}bps`],
    ["Max slippage", `${s.maxSlippageBps}bps`],
    ["Max issuer transfer fee", `${s.maxTransferFeeBps}bps`],
    ["Volatility: halve / reject", s.highVolatilityThresholdBps ? `${pct(s.highVolatilityThresholdBps, 0)} / ${pct(s.highVolatilityThresholdBps * 2, 0)}` : "—"],
  ];
  return (
    <section className="card p-5 sm:p-6">
      <h2 className="font-display text-3xl">Mandate</h2>
      <p className="mt-1 text-[11px] text-ink-3">Stored on the Core asset in an owner-managed Attributes plugin. It travels with the PORT.</p>
      <dl className="mt-4 divide-y divide-rule text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between py-1.5">
            <dt className="text-ink-2">{k}</dt>
            <dd className="num font-mono">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[11px] text-ink-3">Programs the Asset Signer may invoke: SPL Token, Token-2022, Associated Token, System, Jupiter v6 (validated `route` only).</p>
    </section>
  );
}

/* --------------------------------------------------------------- agent */

function AgentPanel({ snap, env, isOwner, agentDelegated, busy, onDelegate, onRevoke, onRun }: {
  snap: SnapshotDto; env: Env; isOwner: boolean; agentDelegated: boolean; busy: string | null;
  onDelegate: () => void; onRevoke: (executive: string) => void; onRun: (dryRun: boolean) => void;
}) {
  return (
    <section className="card relative overflow-hidden p-5 sm:p-6">
      <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: "var(--agent)" }} />
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-3xl">Agent</h2>
        <span className="font-mono text-[11px]" style={{ color: agentDelegated ? "var(--agent)" : "var(--ink-3)" }}>
          {agentDelegated ? "● delegated" : "○ not delegated"}
        </span>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
        A bounded operator, not a chatbot. It reads positions and validated prices, computes drift, proposes the smallest rebalance back within tolerance, and executes only trades that
        pass every policy check, signing as a registered MPL Agent executive through delegated Core Execute.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <IdentityChip kind="agent" address={env.executive} env={env} />
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <button className="btn btn-ghost" disabled={!!busy} onClick={() => onRun(true)}>
          {busy === "agent-plan" ? "Thinking…" : "Preview plan"}
        </button>
        <button className="btn btn-agent" disabled={!agentDelegated || !!busy} onClick={() => onRun(false)} title={agentDelegated ? "" : "Delegate execution first"}>
          {busy === "agent" ? "Executing…" : "Run agent"}
        </button>
      </div>
      <div className="mt-5 border-t border-rule pt-4">
        <p className="eyebrow mb-2">Delegation (MPL Agent Tools)</p>
        {snap.delegates.length === 0 && (
          <button className="btn btn-ghost" disabled={!isOwner || !env.executive || !!busy} onClick={onDelegate}>
            {busy === "delegate" ? "Delegating…" : "Delegate execution to agent"}
          </button>
        )}
        {snap.delegates.map((d) => (
          <div key={d.record} className="flex flex-wrap items-center justify-between gap-2 py-1">
            <IdentityChip kind="agent" address={d.executiveAuthority} env={env} compact />
            <button className="btn btn-ghost !py-1 !text-[12px]" disabled={!isOwner || !!busy} onClick={() => onRevoke(d.executiveAuthority)}>
              {busy === "revoke" ? "Revoking…" : "Revoke"}
            </button>
          </div>
        ))}
        <p className="mt-2 text-[11px] text-ink-3">Delegations persist across ownership transfers. A new owner inherits them and should review.</p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ activity */

const ACTION_VERB: Record<PortActivity["action"], string> = {
  create: "Created PORT", deposit: "Deposited", trade: "Traded", delegate: "Delegated execution", revoke: "Revoked delegation", transfer: "Transferred PORT",
};

function Activity({ activity, env, snap }: { activity: PortActivity[]; env: Env; snap: SnapshotDto }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card mt-6 p-5 sm:p-6">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-3xl">Activity</h2>
        <span className="text-[11px] text-ink-3">signed actions are verified on-chain before they are recorded</span>
      </div>
      {activity.length === 0 && <p className="mt-4 text-sm text-ink-3">No activity yet.</p>}
      <ol className="mt-4 divide-y divide-rule">
        {activity.map((a) => {
          const d = (a.details ?? {}) as Record<string, any>;
          const failed = a.riskDecision?.checks.filter((c) => !c.passed) ?? [];
          const kind = a.authority === "delegate" ? "agent" : a.actor === snap.port.owner ? "owner" : "wallet";
          return (
            <li key={a.id} className="py-3">
              <button className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left" onClick={() => setOpen(open === a.id ? null : a.id)}>
                <span
                  className="rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
                  style={{
                    color: a.status === "confirmed" ? "var(--pass)" : a.status === "failed" ? "var(--fail)" : "var(--ink-3)",
                    background: a.status === "failed" ? "var(--fail-soft)" : "transparent",
                    border: "1px solid currentColor",
                  }}
                >
                  {a.status === "failed" && a.riskDecision && !a.riskDecision.allowed ? "blocked" : a.status}
                </span>
                <span className="font-semibold">
                  {ACTION_VERB[a.action]}
                  {a.action === "trade" && ` · ${d.side} ${d.symbol} ${d.notionalE8 ? usd(d.notionalE8) : ""}`}
                  {a.action === "deposit" && d.amount && ` ${units(d.amount, 6, 2)} ${d.symbol}`}
                </span>
                <IdentityChip kind={kind as "agent" | "owner" | "wallet"} address={a.actor} compact />
                {a.action === "transfer" && d.to && (
                  <>
                    <span className="text-ink-3">→</span>
                    <IdentityChip kind="owner" address={d.to} compact />
                  </>
                )}
                <span className="flex-1" />
                <TxLink sig={a.signature} env={env} />
                <span className="font-mono text-[11px] text-ink-3">{new Date(a.timestamp).toLocaleTimeString()}</span>
              </button>
              {a.rationale && <p className="mt-1 text-[12.5px] text-ink-2">{a.rationale}</p>}
              {failed.length > 0 && <p className="mt-1 text-[12px] text-fail">Blocked by {failed.map((c) => c.code).join(", ")}</p>}
              {typeof d.error === "string" && <p className="mt-1 text-[12px] text-fail">{d.error}</p>}
              {open === a.id && a.riskDecision && (
                <div className="mt-3 rounded-lg bg-paper-2 p-3">
                  <Checks checks={a.riskDecision.checks} dense />
                  {Array.isArray(d.route) && d.route.length > 0 && <p className="mt-2 font-mono text-[11px] text-ink-3">route: Jupiter → {d.route.join(" → ")}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ----------------------------------------------------------- modals */

function ReviewModal({ review, env, isOwner, busy, onClose, onExecute }: {
  review: { proposal: ProposalDto & { results?: PortActivity[] }; by: "owner" | "agent" }; env: Env; isOwner: boolean; busy: string | null;
  onClose: () => void; onExecute: (trades: TradeDto[]) => void;
}) {
  const { proposal, by } = review;
  const approved = proposal.trades.filter((t) => t.decision.allowed && t.prepared);
  const results = proposal.results ?? [];
  return (
    <Modal open onClose={onClose} title={by === "agent" ? (results.length ? "Agent run" : "Agent plan") : "Rebalance review"} wide>
      <p className="text-[13.5px] leading-relaxed text-ink-2">{proposal.plan.rationale}</p>
      <div className="mt-5 space-y-4">
        {proposal.trades.map((t, i) => {
          const r = results.find((x) => (x.details as any)?.symbol === t.trade.symbol && (x.details as any)?.side === t.trade.side);
          return (
            <div key={i} className="rounded-xl border p-4" style={{ borderColor: t.decision.allowed ? "var(--rule)" : "color-mix(in oklab, var(--fail) 45%, transparent)" }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">
                  {t.trade.side === "buy" ? "Buy" : "Sell"} {t.trade.symbol} <span className="num font-mono">{usd(t.trade.notionalE8)}</span>
                </p>
                <span className="font-mono text-[11px]" style={{ color: t.decision.allowed ? "var(--pass)" : "var(--fail)" }}>
                  {t.decision.allowed ? `approved · ${t.decision.checks.length} checks` : `blocked · ${t.decision.checks.filter((c) => !c.passed).length} failed`}
                </span>
              </div>
              <p className="mt-1 text-[12px] text-ink-3">{t.trade.reasons.join(" · ")}</p>
              {t.prepared && (
                <p className="mt-1 font-mono text-[11px] text-ink-3">
                  Jupiter → {t.prepared.routeLabels.join(" → ")} · min out {t.prepared.quote.minOutAmount} raw · issuer fee {t.prepared.quote.transferFeeBps ?? 0}bps · signed by ⬢ Asset Signer via Core Execute
                </p>
              )}
              <div className="mt-3">
                <Checks checks={t.decision.checks} dense />
              </div>
              {r && (
                <p className="mt-2 text-[12px]">
                  <span style={{ color: r.status === "confirmed" ? "var(--pass)" : "var(--fail)" }}>{r.status}</span> <TxLink sig={r.signature} env={env} />
                </p>
              )}
            </div>
          );
        })}
        {proposal.trades.length === 0 && <Banner tone="info">Nothing to do: every position is within tolerance, or no trade survives the limits.</Banner>}
      </div>
      {by === "owner" && approved.length > 0 && (
        <div className="mt-6 flex items-center justify-between gap-3 border-t border-rule pt-4">
          <p className="text-[12px] text-ink-3">
            {approved.length} of {proposal.trades.length} approved. Each becomes one Core Execute transaction signed by you, as owner.
          </p>
          <button className="btn btn-owner" disabled={!isOwner || !!busy} onClick={() => onExecute(approved)}>
            {busy?.startsWith("trade") ? "Signing…" : `Sign & execute ${approved.length}`}
          </button>
        </div>
      )}
    </Modal>
  );
}

function DepositForm({ busy, onSubmit }: { busy: boolean; onSubmit: (n: number) => void }) {
  const [n, setN] = useState("2500");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const v = Number(n);
        if (Number.isInteger(v) && v > 0) onSubmit(v);
      }}
    >
      <p className="text-[13px] text-ink-2">Moves USDC from your wallet into a token account owned by the PORT’s Asset Signer. From then on only Core Execute can move it.</p>
      <label className="eyebrow mt-4 block">Amount (USDC)</label>
      <input className="input mt-1" inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/[^\d]/g, ""))} />
      <button className="btn mt-4 w-full" disabled={busy || !n}>
        {busy ? "Depositing…" : "Deposit"}
      </button>
    </form>
  );
}

function TradeForm({ snap, busy, onSubmit }: { snap: SnapshotDto; busy: boolean; onSubmit: (r: { side: "buy" | "sell"; symbol: string; notionalUsd: string }) => void }) {
  const symbols = snap.port.strategy.targets.filter((t) => t.mint !== snap.port.strategy.cashMint).map((t) => t.symbol);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [symbol, setSymbol] = useState(symbols[0] ?? "");
  const [amount, setAmount] = useState("50");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ side, symbol, notionalUsd: amount });
      }}
    >
      <p className="text-[13px] text-ink-2">A discretionary trade still runs every policy check before you can sign it.</p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <select className="input" value={side} onChange={(e) => setSide(e.target.value as "buy" | "sell")}>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
        <select className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
          {symbols.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>
      <label className="eyebrow mt-4 block">Notional (USD)</label>
      <input className="input mt-1" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
      <button className="btn mt-4 w-full" disabled={busy || !amount}>
        {busy ? "Quoting & checking…" : "Review trade"}
      </button>
    </form>
  );
}

function TransferForm({ snap, from, suggested, busy, onSubmit }: { snap: SnapshotDto; from: Wallet; suggested?: Wallet; busy: boolean; onSubmit: (to: string) => void }) {
  const [to, setTo] = useState(suggested?.signer.publicKey ?? "");
  const valid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to) && to !== from.signer.publicKey;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(to);
      }}
    >
      <p className="text-[14px] leading-relaxed text-ink-2">
        One Core transfer moves ownership of the whole account: {snap.valuation.positions.filter((p) => BigInt(p.amount) > 0n).length} positions worth {usd(snap.valuation.navE8)}, the
        mandate, the agent registration and the history. <b>No token moves.</b> The Asset Signer stays at <span className="font-mono text-signer">{short(snap.port.signer, 6)}</span>.
      </p>
      <div className="mt-5 grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <div>
          <p className="eyebrow mb-1">From</p>
          <IdentityChip kind="owner" address={from.signer.publicKey} />
        </div>
        <span className="hidden font-display text-3xl text-owner sm:block">→</span>
        <div>
          <p className="eyebrow mb-1">To</p>
          <input className="input" value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="new owner address" />
          {suggested && to !== suggested.signer.publicKey && (
            <button type="button" className="mt-1 text-[12px] text-wallet underline" onClick={() => setTo(suggested.signer.publicKey)}>
              use {suggested.label}
            </button>
          )}
        </div>
      </div>
      {snap.delegates.length > 0 && (
        <div className="mt-4">
          <Banner tone="agent">The agent delegation will stay active after transfer. The new owner inherits it and can revoke it.</Banner>
        </div>
      )}
      <button className="btn btn-owner mt-6 w-full" disabled={busy || !valid}>
        {busy ? "Transferring…" : "Transfer ownership"}
      </button>
    </form>
  );
}

function TransferProofModal({ proof, env, wallets, onSwitch, onClose }: { proof: TransferProof; env: Env; wallets: Wallet[]; onSwitch: (i: 0 | 1) => void; onClose: () => void }) {
  const { before, after } = proof;
  const same = (a: string, b: string) => (a === b ? <span className="font-mono text-[11px] text-pass">✓ unchanged</span> : <span className="font-mono text-[11px] text-fail">changed</span>);
  const balancesSame = JSON.stringify(before.balances.map((b) => [b.mint, b.amount, b.tokenAccount])) === JSON.stringify(after.balances.map((b) => [b.mint, b.amount, b.tokenAccount]));
  const nextIdx = wallets.findIndex((w) => w.signer.publicKey === proof.to);
  return (
    <Modal open onClose={onClose} title="Title transferred" wide>
      <div className="relative">
        <div className="stamp pointer-events-none absolute -top-2 right-2 rounded-md border-[3px] px-3 py-1 font-display text-2xl uppercase tracking-widest text-owner" style={{ borderColor: "var(--owner)" }}>
          Conveyed
        </div>
        <p className="max-w-lg text-[14px] leading-relaxed text-ink-2">
          The stocks never moved. Ownership of the programmable account did. <TxLink sig={proof.signature} env={env} label="transfer tx" />
        </p>
      </div>
      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[520px] text-[13px]">
          <thead>
            <tr className="eyebrow text-left">
              <th className="pb-2 font-normal" />
              <th className="pb-2 font-normal">Before</th>
              <th className="pb-2 font-normal">After</th>
              <th className="pb-2 font-normal" />
            </tr>
          </thead>
          <tbody className="align-middle">
            <tr className="border-t border-rule">
              <td className="py-2.5 font-semibold">Core owner</td>
              <td className="py-2.5 line-through decoration-owner/60">
                <IdentityChip kind="owner" address={before.port.owner} compact />
              </td>
              <td className="py-2.5">
                <IdentityChip kind="owner" address={after.port.owner} compact />
              </td>
              <td className="py-2.5 font-mono text-[11px] text-owner">→ new owner</td>
            </tr>
            <tr className="border-t border-rule">
              <td className="py-2.5 font-semibold">Asset Signer</td>
              <td className="py-2.5">
                <IdentityChip kind="signer" address={before.port.signer} compact />
              </td>
              <td className="py-2.5">
                <IdentityChip kind="signer" address={after.port.signer} compact />
              </td>
              <td className="py-2.5">{same(before.port.signer, after.port.signer)}</td>
            </tr>
            {after.valuation.positions.map((p) => {
              const b = before.valuation.positions.find((x) => x.mint === p.mint);
              return (
                <tr key={p.mint} className="border-t border-rule">
                  <td className="py-2 text-ink-2">{p.symbol}</td>
                  <td className="num py-2 font-mono text-[12px]">{b ? units(b.amount, b.decimals, 6) : "—"}</td>
                  <td className="num py-2 font-mono text-[12px]">{units(p.amount, p.decimals, 6)}</td>
                  <td className="py-2">{same(b?.amount ?? "", p.amount)}</td>
                </tr>
              );
            })}
            <tr className="border-t border-rule">
              <td className="py-2.5 font-semibold">Mandate</td>
              <td className="py-2.5 text-ink-3">{before.port.strategy.name}</td>
              <td className="py-2.5 text-ink-3">{after.port.strategy.name}</td>
              <td className="py-2.5">{same(JSON.stringify(before.port.strategy), JSON.stringify(after.port.strategy))}</td>
            </tr>
            <tr className="border-t border-rule">
              <td className="py-2.5 font-semibold">Agent delegation</td>
              <td className="py-2.5 text-ink-3">{before.delegates.length ? `${before.delegates.length} active` : "none"}</td>
              <td className="py-2.5 text-ink-3">{after.delegates.length ? `${after.delegates.length} active (inherited)` : "none"}</td>
              <td className="py-2.5 font-mono text-[11px] text-agent">{after.delegates.length ? "review →" : ""}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 font-mono text-[11px]" style={{ color: balancesSame ? "var(--pass)" : "var(--fail)" }}>
        {balancesSame ? "✓ every token account, balance and address identical" : "balances differ (a trade may have landed in between)"}
      </p>
      {nextIdx >= 0 && (
        <button className="btn btn-owner mt-6 w-full" onClick={() => onSwitch(nextIdx as 0 | 1)}>
          Connect as {wallets[nextIdx]!.label} (the new owner) →
        </button>
      )}
    </Modal>
  );
}
