import { describe, expect, it } from "vitest";
import { AGENT_MARKET_DESIGN, agentCurveConfig } from "../src/meteora";

describe("agent market curve", () => {
  it("builds a DAMM v2-migrating, quote-fee config for NVDAx", () => {
    const c = agentCurveConfig();
    expect(c.migrationOption).toBe(1); // MET_DAMM_V2
    expect(c.collectFeeMode).toBe(0); // fees in quote (NVDAx)
    expect(c.tokenDecimal).toBe(6);
    expect(c.creatorTradingFeePercentage).toBe(AGENT_MARKET_DESIGN.creatorTradingFeePercentage);
    // 10 NVDAx at 8 decimals
    expect(c.migrationQuoteThreshold.toString()).toBe("1000000000");
    expect(c.curve.length).toBeGreaterThan(0);
  });
});
