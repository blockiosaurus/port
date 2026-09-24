export const dynamic = "force-dynamic";

/**
 * Deployment self-check: which Node the function runs on, and whether the one unbundled
 * dependency (the Meteora SDK, a serverExternalPackage) loads. Imports nothing from lib/server
 * on purpose, so it still answers when the other routes fail at import time.
 */
export async function GET() {
  let meteoraSdk = "ok";
  try {
    await import("@meteora-ag/dynamic-bonding-curve-sdk");
  } catch (e) {
    meteoraSdk = (e as Error)?.message ?? String(e);
  }
  return Response.json({ node: process.version, meteoraSdk, cluster: process.env.PORT_CLUSTER ?? "fork (default)" });
}
