"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DEMO_STRATEGY } from "@port/integrations/demo";
import { DISCLAIMER } from "@port/shared";
import { actionCreate, faucet, rememberPort, rememberedPorts, umiFor, useEnv, useWallets } from "@/lib/client";
import { short, pct } from "@/lib/format";
import { Banner, IdentityChip, IdentityLegend, Shell } from "@/components/ui";

export default function Home() {
  const env = useEnv();
  const { wallets, active, activeIndex, setActive } = useWallets();
  const router = useRouter();
  const [ports, setPorts] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState("");
  useEffect(() => setPorts(rememberedPorts()), []);

  async function create() {
    if (!env || !active) return;
    setError(null);
    try {
      setStatus("Minting the Core asset with its sealed mandate…");
      const res = await actionCreate(umiFor(env.rpcUrl, active), active);
      rememberPort(res.asset);
      setStatus("Registered agent identity and renounced update authority.");
      router.push(`/port/${res.asset}`);
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    }
  }

  return (
    <Shell env={env} wallets={wallets} activeIndex={activeIndex} setActive={setActive} onFaucet={
        env && active
          ? async () => {
              setError(null);
              await faucet(env, active)
                .then(() => setStatus(null))
                .catch((e: Error) => setError(`Faucet: ${e.message}`));
            }
          : undefined
      }
    >
      <section className="grid gap-10 pt-12 lg:grid-cols-[1.25fr_1fr] lg:pt-20">
        <div className="rise">
          <p className="eyebrow">Stocklana · Metaplex Core Execute · PreStocks</p>
          <h1 className="mt-4 font-display text-[clamp(3rem,8vw,6.4rem)] leading-[0.92] tracking-tight">
            An investment account <em className="text-owner">you can own.</em>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-2">
            A PORT is a Metaplex Core asset. Its deterministic <span className="font-semibold text-signer">Asset Signer</span> holds a portfolio of pre-IPO PreStocks and USDC and trades
            only through <span className="font-mono text-[0.95em]">Core Execute</span>. Hand it to a bounded agent, revoke it, or sell the whole account. The positions never move. Only the
            ownership does.
          </p>
          <div className="mt-6">
            <IdentityLegend />
          </div>
        </div>

        <div className="card rise p-6 [animation-delay:120ms] sm:p-7">
          <p className="eyebrow">New PORT</p>
          <h2 className="mt-2 font-display text-4xl leading-none">{DEMO_STRATEGY.name}</h2>
          <table className="mt-5 w-full text-sm">
            <tbody>
              {DEMO_STRATEGY.targets.map((t) => (
                <tr key={t.mint} className="border-b border-rule last:border-0">
                  <td className="py-2 font-semibold">{t.symbol}</td>
                  <td className="py-2 font-mono text-[11px] text-ink-3">{short(t.mint, 5)}</td>
                  <td className="num py-2 text-right font-mono">{pct(t.weightBps, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
            xAI and Databricks are not issued by PreStocks; SpaceX and Anduril take their places. The mandate (weights, cash floor {pct(DEMO_STRATEGY.minCashWeightBps, 0)}, max trade{" "}
            {pct(DEMO_STRATEGY.maxTradeNavBps, 0)} of NAV, price age ≤ {DEMO_STRATEGY.maxPriceAgeSeconds}s) is stored on the asset in an owner-managed plugin.
          </p>

          <ol className="mt-6 space-y-3 text-sm">
            <li className="flex items-center justify-between gap-3">
              <span>
                <span className="font-mono text-ink-3">01</span> Connected as
              </span>
              {active ? <IdentityChip kind="wallet" address={active.signer.publicKey} /> : <span className="text-ink-3">…</span>}
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>
                <span className="font-mono text-ink-3">02</span> Fund it (fork faucet)
              </span>
              <span className="text-[12px] text-ink-3">header → Faucet</span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>
                <span className="font-mono text-ink-3">03</span> Mint the PORT
              </span>
              <button className="btn btn-owner" disabled={!env || !active || !!status} onClick={create}>
                {status ? "Minting…" : "Create PORT"}
              </button>
            </li>
          </ol>
          {status && <p className="mt-4 text-[13px] text-ink-2">{status}</p>}
          {error && (
            <div className="mt-4">
              <Banner tone="fail">{error}</Banner>
            </div>
          )}
        </div>
      </section>

      <section className="mt-16 grid gap-6 lg:grid-cols-2">
        <div className="card p-6">
          <p className="eyebrow">Open a PORT</p>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (open.trim()) router.push(`/port/${open.trim()}`);
            }}
          >
            <input className="input" placeholder="Core asset address" value={open} onChange={(e) => setOpen(e.target.value)} />
            <button className="btn btn-ghost">Open</button>
          </form>
          <ul className="mt-4 space-y-2">
            {env?.demo?.asset && (
              <li>
                <Link className="font-mono text-[13px] text-wallet hover:underline" href={`/port/${env.demo.asset}`}>
                  {short(env.demo.asset, 6)}
                </Link>{" "}
                <span className="text-[12px] text-ink-3">scripted demo (bootstrap)</span>
              </li>
            )}
            {ports.map((p) => (
              <li key={p}>
                <Link className="font-mono text-[13px] text-wallet hover:underline" href={`/port/${p}`}>
                  {short(p, 6)}
                </Link>{" "}
                <span className="text-[12px] text-ink-3">created in this browser</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="p-2 text-[12px] leading-relaxed text-ink-3">
          <p className="eyebrow mb-2">Disclosure</p>
          <p>{DISCLAIMER}</p>
          <p className="mt-2">
            PreStocks are Token-2022 assets with a 1% transfer fee, issuer pause and a permanent delegate. PORT surfaces these risks and prices them into every trade. Not available to US
            persons.
          </p>
        </div>
      </section>
    </Shell>
  );
}
