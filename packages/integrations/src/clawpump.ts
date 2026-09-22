import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * ClawPump REST client, mirroring the endpoints the official `clawpump` CLI (v0.13.1) calls:
 *   POST /api/v1/agents  {name, strategy}                      → { id, walletAddress }
 *   POST /api/v1/launch  {agentId, name, symbol, description, image_url, initialBuySol?, selfFunded?}
 *                                                              → { mintAddress, pumpUrl }
 * Auth: `Authorization: Bearer cpk_…` (dashboard API key) plus an idempotency key on launches.
 *
 *   GET  /api/v1/pump-pairs                                    → { assets[{mint,symbol}], creatorFeeBps{min,max} }
 *
 * ClawPump's Solana launches go to pump.fun and can be paired with a listed asset via
 * `pumpQuoteMint` (tokenized stocks included, e.g. NVDAx) with a 1–3% creator fee
 * (`pumpCreatorFeeBps`). Launching creates a public mainnet token: callers must get explicit
 * confirmation first. Nothing here runs without CLAWPUMP_API_KEY.
 */
const AgentRes = z.object({ id: z.string(), walletAddress: z.string().nullish() }).passthrough();
const LaunchRes = z.object({ mintAddress: z.string().nullish(), pumpUrl: z.string().nullish(), error: z.string().nullish() }).passthrough();

const PumpPairs = z.object({
  assets: z.array(z.object({ mint: z.string(), symbol: z.string(), name: z.string().optional(), decimals: z.number().optional() }).passthrough()),
  creatorFeeBps: z.object({ min: z.number(), max: z.number(), default: z.number().optional() }).passthrough(),
}).passthrough();

export type ClawpumpLaunch = {
  name: string; symbol: string; description: string; imageUrl: string; initialBuySol?: number;
  /** Pair asset from /pump-pairs (e.g. NVDAx); omitted → standard SOL pair. */
  pumpQuoteMint?: string;
  /** Creator fee on the pump.fun pair, 100–300 bps. */
  pumpCreatorFeeBps?: number;
};

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

  async pumpPairs() {
    if (!this.apiKey) throw new Error("CLAWPUMP_API_KEY is not set (dashboard key, cpk_…)");
    const res = await this.fetcher(`${this.baseUrl}/api/v1/pump-pairs`, { headers: { authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) throw new Error(`ClawPump pump-pairs ${res.status}`);
    return PumpPairs.parse(await res.json());
  }

  /** Registers the operator as a ClawPump agent; `monitor-exit` grants no trading skills. */
  createAgent(name: string, strategy: "monitor-exit" | "defi-yield" = "monitor-exit") {
    return this.post("/api/v1/agents", { name, strategy }, AgentRes);
  }

  async launchSolana(agentId: string, l: ClawpumpLaunch) {
    const body: Record<string, unknown> = { agentId, name: l.name, symbol: l.symbol, description: l.description, image_url: l.imageUrl };
    if (l.initialBuySol) body.initialBuySol = l.initialBuySol;
    if (l.pumpQuoteMint) body.pumpQuoteMint = l.pumpQuoteMint;
    if (l.pumpCreatorFeeBps !== undefined) {
      if (l.pumpCreatorFeeBps < 100 || l.pumpCreatorFeeBps > 300) throw new Error("pumpCreatorFeeBps must be 100–300");
      body.pumpCreatorFeeBps = l.pumpCreatorFeeBps;
    }
    return this.post("/api/v1/launch", body, LaunchRes, true);
  }
}
