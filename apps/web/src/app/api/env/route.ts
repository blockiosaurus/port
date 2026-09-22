import { env, json, demoState } from "@/lib/server";
export const dynamic = "force-dynamic";
export async function GET() {
  const state = demoState();
  return json({ ...env(), demo: state ? { asset: state.asset, walletA: state.walletA, walletB: state.walletB } : null });
}
