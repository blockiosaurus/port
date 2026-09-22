import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { AGENT_MARKET_DESIGN, ClawpumpClient, readAgentMarket } from "@port/integrations";
import { json, ROOT, RPC_URL } from "@/lib/server";

export const dynamic = "force-dynamic";

/** The agent token's Meteora DBC market (launched by scripts/launch-agent-market.ts), read live. */
export async function GET() {
  const path = join(ROOT, ".demo/agent-market.json");
  const clawpump = { configured: new ClawpumpClient().configured };
  if (!existsSync(path)) return json({ market: null, design: AGENT_MARKET_DESIGN, clawpump });
  const saved = JSON.parse(readFileSync(path, "utf8"));
  try {
    const state = await readAgentMarket(new Connection(RPC_URL, "confirmed"), new PublicKey(saved.pool));
    return json({ market: { ...saved, state }, design: AGENT_MARKET_DESIGN, clawpump });
  } catch (e) {
    return json({ market: { ...saved, stale: (e as Error).message }, design: AGENT_MARKET_DESIGN, clawpump });
  }
}
