import { z } from "zod";
import { executeRebalance } from "@port/integrations";
import { fetchDelegate } from "@port/port-sdk";
import { publicKey } from "@metaplex-foundation/umi";
import { agentContext, errorJson, executive, json } from "@/lib/server";
import { snapshotDto, tradeDto } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The autonomous operator: plans deterministically, runs every policy check against live
 * quotes, and executes only approved trades via delegated Core Execute. Its key stays here.
 */
export async function POST(req: Request) {
  try {
    const { asset, dryRun } = z.object({ asset: z.string(), dryRun: z.boolean().optional() }).parse(await req.json());
    const signer = executive();
    if (!signer) throw new Error("Agent executive key not configured (.keys/executive.json)");
    const ctx = agentContext(signer);
    if (!dryRun && !(await fetchDelegate(ctx.umi, publicKey(asset), signer.publicKey)))
      return json({ error: "The agent has no execution delegation for this PORT. The owner must delegate first.", code: "NOT_DELEGATED" }, { status: 403 });
    const r = await executeRebalance(ctx, asset, "delegate", dryRun ? 0 : 8);
    return json({
      snapshot: snapshotDto(r.proposal.snapshot),
      plan: { withinTolerance: r.proposal.plan.withinTolerance, rationale: r.proposal.plan.rationale },
      trades: r.proposal.trades.map(tradeDto),
      results: r.results.map((x) => x.activity),
    });
  } catch (e) {
    return errorJson(e);
  }
}
