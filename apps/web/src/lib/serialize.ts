import "server-only";
import type { EvaluatedTrade, PortSnapshot } from "@port/integrations";
import type { SnapshotDto, TradeDto } from "./dto";

const s = (v: bigint) => v.toString();

export function snapshotDto(x: PortSnapshot): SnapshotDto {
  const { raw: _raw, ...port } = x.port;
  return JSON.parse(
    JSON.stringify({
      port,
      balances: x.balances,
      prices: Object.fromEntries(x.prices),
      valuation: x.valuation,
      delegates: x.delegates,
      profiles: Object.fromEntries(x.profiles),
      warnings: x.warnings,
      fetchedAt: Date.now(),
    }, (_, v) => (typeof v === "bigint" ? s(v) : v)),
  );
}

export function tradeDto(t: EvaluatedTrade): TradeDto {
  return JSON.parse(
    JSON.stringify({
      trade: t.trade,
      decision: t.decision,
      error: t.error,
      prepared: t.prepared && {
        quote: t.prepared.quote,
        routeLabels: t.prepared.routeLabels,
        addressLookupTables: t.prepared.addressLookupTables,
        instructions: t.prepared.instructions.map((ix) => ({ programId: ix.programId, keys: ix.keys, data: Buffer.from(ix.data).toString("base64") })),
      },
    }, (_, v) => (typeof v === "bigint" ? s(v) : v)),
  );
}
