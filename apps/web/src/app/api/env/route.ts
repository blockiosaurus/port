import { env, json, demoState, ensureAgentExecutive } from "@/lib/server";
export const dynamic = "force-dynamic";
export async function GET() {
  const state = demoState();
  const agentError = await ensureAgentExecutive().then(() => null, (e: Error) => e.message);
  return json({ ...env(), agentError, demo: state ? { asset: state.asset, walletA: state.walletA, walletB: state.walletB } : null });
}
