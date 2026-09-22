import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * ClawPump REST client, mirroring the endpoints the official `clawpump` CLI (v0.13.1) calls:
 *   POST /api/v1/agents  {name, strategy}                      → { id, walletAddress }
 *   POST /api/v1/launch  {agentId, name, symbol, description, image_url, initialBuySol?, selfFunded?}
 *                                                              → { mintAddress, pumpUrl }
 * Auth: `Authorization: Bearer cpk_…` (dashboard API key) plus an idempotency key on launches.
 *
 * As published today, ClawPump's Solana launch path is pump.fun; its stock-paired path
 * (/api/v1/launch/pools) targets Robinhood Chain (EVM). PORT's stock-quoted Meteora DBC market is
 * therefore created by our own adapter (./meteora.ts), and this client registers/launches the
 * operator on ClawPump when a key is supplied. Nothing here runs without CLAWPUMP_API_KEY.
 */
const AgentRes = z.object({ id: z.string(), walletAddress: z.string().nullish() }).passthrough();
const LaunchRes = z.object({ mintAddress: z.string().nullish(), pumpUrl: z.string().nullish(), error: z.string().nullish() }).passthrough();

export type ClawpumpLaunch = { name: string; symbol: string; description: string; imageUrl: string; initialBuySol?: number };

export class ClawpumpClient {
  constructor(
    private readonly apiKey = process.env.CLAWPUMP_API_KEY,
    private readonly baseUrl = (process.env.CLAWPUMP_BASE ?? "https://clawpump.tech").replace(/\/+$/, ""),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  get configured() {
    return Boolean(this.apiKey);
  }

  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>, idempotent = false): Promise<T> {
    if (!this.apiKey) throw new Error("CLAWPUMP_API_KEY is not set (dashboard key, cpk_…)");
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, ...(idempotent ? { "idempotency-key": randomUUID() } : {}) },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`ClawPump ${path} ${res.status}: ${(data as { error?: string }).error ?? res.statusText}`);
    return schema.parse(data);
  }

  /** Registers the operator as a ClawPump agent; `monitor-exit` grants no trading skills. */
  createAgent(name: string, strategy: "monitor-exit" | "defi-yield" = "monitor-exit") {
    return this.post("/api/v1/agents", { name, strategy }, AgentRes);
  }

  launchSolana(agentId: string, l: ClawpumpLaunch) {
    const body: Record<string, unknown> = { agentId, name: l.name, symbol: l.symbol, description: l.description, image_url: l.imageUrl };
    if (l.initialBuySol) body.initialBuySol = l.initialBuySol;
    return this.post("/api/v1/launch", body, LaunchRes, true);
  }
}
