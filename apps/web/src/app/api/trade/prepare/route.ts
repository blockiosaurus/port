import { z } from "zod";
import { proposeRebalance, proposeTrade } from "@port/integrations";
import { errorJson, json, readContext } from "@/lib/server";
import { snapshotDto, tradeDto } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rebalance"), asset: z.string(), authority: z.string() }),
  z.object({ kind: z.literal("manual"), asset: z.string(), authority: z.string(), side: z.enum(["buy", "sell"]), symbol: z.string(), notionalUsd: z.string().regex(/^\d+(\.\d{1,2})?$/) }),
]);

/**
 * Quotes, validates and risk-checks trades for the Asset Signer. Returns instructions for the
 * connected owner to wrap in Core Execute and sign in the browser; nothing is signed here.
 */
export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const ctx = readContext(body.authority);
    if (body.kind === "rebalance") {
      const p = await proposeRebalance(ctx, body.asset);
      return json({ snapshot: snapshotDto(p.snapshot), plan: { withinTolerance: p.plan.withinTolerance, rationale: p.plan.rationale }, trades: p.trades.map(tradeDto) });
    }
    const p = await proposeTrade(ctx, body.asset, body);
    return json({ snapshot: snapshotDto(p.snapshot), plan: { withinTolerance: false, rationale: p.trade.trade.reasons.join("; ") }, trades: [tradeDto(p.trade)] });
  } catch (e) {
    return errorJson(e);
  }
}
