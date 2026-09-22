import { loadSnapshot } from "@port/integrations";
import { activity, agentContext, env, errorJson, json, executive } from "@/lib/server";
import { snapshotDto } from "@/lib/serialize";
import { createNoopSigner, publicKey } from "@metaplex-foundation/umi";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ asset: string }> }) {
  const { asset } = await params;
  try {
    const ctx = agentContext(executive() ?? createNoopSigner(publicKey(asset)));
    const [snapshot, log] = await Promise.all([loadSnapshot(ctx, asset), activity.list(asset)]);
    return json({ env: env(), snapshot: snapshotDto(snapshot), activity: log });
  } catch (e) {
    return errorJson(e, 404);
  }
}
