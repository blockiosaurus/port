import { describe, expect, it } from "vitest";
import quoteJson from "./fixtures/q.json";
import siJson from "./fixtures/si.json";
import { JupQuoteSchema, toTradeQuote, validateSwapInstructions } from "../src/jupiter";

// Real Jupiter v6 response captured 2026-09-22: 5 USDC → OPENAI PreStocks via Meteora DLMM,
// user = an Asset Signer PDA.
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OPENAI = "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF";
const signer = "53RVrfirkd5HoWT9CwoKbQjSt1pk2B3Z5A8M1DGbPxdq";
const expected = { authority: signer, sourceTokenAccount: "4833xMrU6Gfx7d18R5oz1tUtUuN4rDnNh5usnrvq5Mzq", destinationTokenAccount: "E6S5UdH7USifbpa6sKhdqYMcZpwo42ew4vKw42SBjFp2" };
const req = { inputMint: USDC, outputMint: OPENAI, amountIn: 5_000_000n, slippageBps: 100 };
const raw = JupQuoteSchema.parse(quoteJson);
const clone = () => JSON.parse(JSON.stringify(siJson)) as any;
const setTail = (si: any, f: (b: Buffer) => void) => {
  const d = Buffer.from(si.swapInstruction.data, "base64");
  f(d.subarray(d.length - 19));
  si.swapInstruction.data = d.toString("base64");
  return si;
};

describe("validateSwapInstructions", () => {
  it("accepts the genuine route and drops compute-budget instructions", () => {
    const ixs = validateSwapInstructions(clone(), req, raw, expected);
    expect(ixs.map((i) => i.programId)).toEqual(["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"]);
  });

  it.each<[string, (si: any) => any, RegExp]>([
    ["foreign authority", (si) => { si.swapInstruction.accounts[1].pubkey = USDC; return si; }, /authority/],
    ["redirected destination", (si) => { si.swapInstruction.accounts[3].pubkey = USDC; return si; }, /destination must be/],
    ["third-party destination", (si) => { si.swapInstruction.accounts[4].pubkey = USDC; return si; }, /third-party/],
    ["platform fee account", (si) => { si.swapInstruction.accounts[6].pubkey = USDC; return si; }, /platform fee account/],
    ["inflated amount", (si) => setTail(si, (t) => t.writeBigUInt64LE(50_000_000n, 0)), /in_amount/],
    ["wider slippage", (si) => setTail(si, (t) => t.writeUInt16LE(5000, 16)), /slippage/],
    ["platform fee", (si) => setTail(si, (t) => t.writeUInt8(50, 18)), /platform fee must be zero/],
    ["other program", (si) => { si.swapInstruction.programId = USDC; return si; }, /not Jupiter/],
    ["other variant", (si) => { const d = Buffer.from(si.swapInstruction.data, "base64"); d[0] = 0; si.swapInstruction.data = d.toString("base64"); return si; }, /Only Jupiter `route`/],
    ["extra instruction", (si) => { si.otherInstructions = [si.swapInstruction]; return si; }, /extra/],
    ["setup for another owner", (si) => { si.setupInstructions[0].accounts[2].pubkey = USDC; return si; }, /not owned/],
  ])("rejects %s", (_, mut, re) => {
    expect(() => validateSwapInstructions(mut(clone()), req, raw, expected)).toThrow(re);
  });

  it("nets the transfer fee out of the reported output", () => {
    const q = toTradeQuote(raw, { ...req, outputTransferFeeBps: 100 });
    expect(q.outAmount).toBe((BigInt(raw.outAmount) * 9900n) / 10000n);
    expect(q.transferFeeBps).toBe(100);
  });
});
