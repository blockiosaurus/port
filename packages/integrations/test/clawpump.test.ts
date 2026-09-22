import { describe, expect, it } from "vitest";
import { ClawpumpClient } from "../src/clawpump";

describe("ClawpumpClient", () => {
  it("refuses to call without a key", async () => {
    await expect(new ClawpumpClient("").createAgent("x")).rejects.toThrow(/CLAWPUMP_API_KEY/);
  });
  it("sends the CLI's request shape with auth and idempotency", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(url.endsWith("/agents") ? { id: "a1", walletAddress: "W" } : { mintAddress: "M", pumpUrl: "https://pump.fun/M" }));
    }) as unknown as typeof fetch;
    const c = new ClawpumpClient("cpk_test", "https://clawpump.tech", fetcher);
    const agent = await c.createAgent("PORT Agent 001");
    const launch = await c.launchSolana(agent.id, { name: "PORT Agent 001", symbol: "PORTA", description: "d", imageUrl: "https://x/i.png" });
    expect(launch.mintAddress).toBe("M");
    expect(calls[0]!.url).toBe("https://clawpump.tech/api/v1/agents");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ agentId: "a1", name: "PORT Agent 001", symbol: "PORTA", description: "d", image_url: "https://x/i.png" });
    const h = calls[1]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer cpk_test");
    expect(h["idempotency-key"]).toMatch(/[0-9a-f-]{36}/);
  });
});
