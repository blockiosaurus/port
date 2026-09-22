import { fromBaseUnits } from "@port/shared";

export const short = (a: string | null | undefined, n = 4) => (a ? `${a.slice(0, n)}…${a.slice(-n)}` : "—");
export const usd = (e8: string | bigint | null | undefined, digits = 2) => {
  if (e8 === null || e8 === undefined) return "—";
  const n = Number(fromBaseUnits(BigInt(e8), 8, digits));
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
};
export const pct = (bps: number, digits = 1) => `${(bps / 100).toFixed(digits)}%`;
export const units = (raw: string | bigint, decimals: number, max = 4) => Number(fromBaseUnits(BigInt(raw), decimals, max)).toLocaleString("en-US", { maximumFractionDigits: max });
export const ago = (unix: number) => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - unix));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

export function explorer(kind: "tx" | "address", id: string, cluster: string, rpcUrl: string) {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  if (cluster === "mainnet-beta") return base;
  if (cluster === "devnet") return `${base}?cluster=devnet`;
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
}
