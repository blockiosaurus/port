import { publicKey, type Instruction, type PublicKey } from "@metaplex-foundation/umi";
import { z } from "zod";
import type { TradeQuote } from "@port/risk-engine";

export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** Anchor discriminator for Jupiter v6 `route`. Other variants are refused. */
const ROUTE_DISCRIMINATOR = "e517cb977ae3ad2a";

const AccountMeta = z.object({ pubkey: z.string(), isSigner: z.boolean(), isWritable: z.boolean() });
const JupIx = z.object({ programId: z.string(), accounts: z.array(AccountMeta), data: z.string() });

export const JupQuoteSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: z.string().regex(/^\d+$/),
    outAmount: z.string().regex(/^\d+$/),
    otherAmountThreshold: z.string().regex(/^\d+$/),
    swapMode: z.literal("ExactIn"),
    slippageBps: z.number().int(),
    priceImpactPct: z.string(),
    platformFee: z.unknown().nullable().optional(),
    routePlan: z.array(z.object({ swapInfo: z.object({ ammKey: z.string(), label: z.string().optional() }), percent: z.number().nullable().optional() })),
  })
  .passthrough();
export type JupQuote = z.infer<typeof JupQuoteSchema>;

const SwapInstructionsSchema = z.object({
  computeBudgetInstructions: z.array(JupIx).default([]),
  setupInstructions: z.array(JupIx).default([]),
  swapInstruction: JupIx,
  cleanupInstruction: JupIx.nullable().optional(),
  otherInstructions: z.array(JupIx).default([]),
  addressLookupTableAddresses: z.array(z.string()),
});

export type TradeRequest = {
  inputMint: string;
  outputMint: string;
  amountIn: bigint;
  /** Market slippage tolerance, excluding token transfer fees. */
  slippageBps: number;
  /** Token-2022 transfer fee on the output mint (PreStocks: 100 bps). Withheld on receipt. */
  outputTransferFeeBps?: number;
  /** Token-2022 transfer fee on the input mint, withheld when the Asset Signer pays the pool. */
  inputTransferFeeBps?: number;
};

/**
 * Jupiter checks the minimum against what actually lands in the destination account, so a
 * transfer fee consumes slippage budget. Request slippage = market tolerance + fees, and
 * report the net (post-fee) expected output to the risk engine.
 */
export function requestedSlippageBps(r: TradeRequest): number {
  // Fees and slippage compound: (1 − fee)(1 − slip) = 1 − (fee + slip − fee·slip). Rounding the
  // product term up keeps the tolerated market slippage at or below `slippageBps`.
  let keep = 10_000n;
  for (const f of [r.inputTransferFeeBps ?? 0, r.outputTransferFeeBps ?? 0, r.slippageBps]) keep = (keep * BigInt(10_000 - f) + 9_999n) / 10_000n;
  return 10_000 - Number(keep);
}

export type PreparedSwap = {
  quote: TradeQuote;
  raw: JupQuote;
  instructions: Instruction[];
  addressLookupTables: string[];
  routeLabels: string[];
};

export type ExpectedAccounts = {
  /** The PORT Asset Signer; the only permitted user authority. */
  authority: string;
  sourceTokenAccount: string;
  destinationTokenAccount: string;
};

export type JupiterOptions = {
  baseUrl?: string;
  /**
   * Single-pool routes: fewer accounts inside Core Execute, deterministic pools (the demo fork
   * clones exactly these), and no intermediate tokens held by the Asset Signer.
   */
  onlyDirectRoutes?: boolean;
  /** Restrict to these Jupiter DEX labels (e.g. to avoid oracle-priced AMMs on a frozen fork). */
  dexes?: string[];
  fetcher?: typeof fetch;
};

/** Process-wide pacing: the free Jupiter tier rate-limits aggressively. */
let nextSlot = 0;
async function paced(fn: () => Promise<Response>, minIntervalMs: number): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Math.max(Date.now(), nextSlot) + minIntervalMs;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const res = await fn();
    if (res.status !== 429 || attempt >= 4) return res;
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
}

export class JupiterTradeAdapter {
  private readonly apiKey = process.env.JUPITER_API_KEY;
  private readonly baseUrl: string;
  private readonly onlyDirectRoutes: boolean;
  private readonly dexes?: string[];
  private readonly fetcher: typeof fetch;
  constructor(opts: JupiterOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.JUPITER_API_URL ?? (process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1");
    this.onlyDirectRoutes = opts.onlyDirectRoutes ?? true;
    this.dexes = opts.dexes;
    this.fetcher = opts.fetcher ?? fetch;
  }

  /** `json` is Jupiter's untouched response; it is what gets sent back for instructions. */
  async quote(req: TradeRequest): Promise<{ quote: TradeQuote; raw: JupQuote; json: unknown }> {
    const url = new URL(`${this.baseUrl}/quote`);
    url.search = new URLSearchParams({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: req.amountIn.toString(),
      slippageBps: String(requestedSlippageBps(req)),
      swapMode: "ExactIn",
      restrictIntermediateTokens: "true",
      onlyDirectRoutes: String(this.onlyDirectRoutes),
      maxAccounts: "40",
      ...(this.dexes ? { dexes: this.dexes.join(",") } : {}),
    }).toString();
    const res = await this.request(url);
    if (!res.ok) throw new Error(`Jupiter quote unavailable (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const json: unknown = await res.json();
    const raw = JupQuoteSchema.parse(json);
    if (raw.inputMint !== req.inputMint || raw.outputMint !== req.outputMint || BigInt(raw.inAmount) !== req.amountIn)
      throw new Error("Jupiter quote does not match the request");
    return { raw, json, quote: toTradeQuote(raw, req) };
  }

  async prepare(req: TradeRequest, expected: ExpectedAccounts): Promise<PreparedSwap> {
    const { raw, json, quote } = await this.quote(req);
    const res = await this.request(`${this.baseUrl}/swap-instructions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteResponse: json, userPublicKey: expected.authority, wrapAndUnwrapSol: false, useSharedAccounts: false, dynamicComputeUnitLimit: false }),
    });
    if (!res.ok) throw new Error(`Jupiter swap-instructions failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const si = SwapInstructionsSchema.parse(await res.json());
    const instructions = validateSwapInstructions(si, req, raw, expected);
    return { quote, raw, instructions, addressLookupTables: si.addressLookupTableAddresses, routeLabels: raw.routePlan.map((r) => r.swapInfo.label ?? r.swapInfo.ammKey) };
  }

  private request(url: string | URL, init: RequestInit = {}) {
    const headers = { ...(init.headers as Record<string, string>), ...(this.apiKey ? { "x-api-key": this.apiKey } : {}) };
    return paced(() => this.fetcher(url, { ...init, headers }), this.apiKey ? 150 : 1100);
  }
}

export function toTradeQuote(raw: JupQuote, req: TradeRequest): TradeQuote {
  const feeBps = BigInt((req.outputTransferFeeBps ?? 0) + (req.inputTransferFeeBps ?? 0));
  const netOut = (BigInt(raw.outAmount) * (10_000n - feeBps)) / 10_000n;
  const minOut = BigInt(raw.otherAmountThreshold);
  return {
    inAmount: BigInt(raw.inAmount),
    outAmount: netOut,
    minOutAmount: minOut,
    // Market slippage actually tolerated beyond the known fee.
    slippageBps: netOut > minOut ? Number(((netOut - minOut) * 10_000n) / netOut) : 0,
    transferFeeBps: Number(feeBps),
    programIds: [JUPITER_PROGRAM, ATA_PROGRAM],
  };
}

/**
 * Jupiter's serialized instructions are untrusted input. Accept only: idempotent ATA creation
 * for the Asset Signer, and a single `route` instruction whose authority, token accounts,
 * output mint, amount, slippage and fee match the risk-approved request. Compute-budget
 * instructions are dropped (Core Execute cannot wrap them; the caller sets its own).
 */
export function validateSwapInstructions(
  si: z.infer<typeof SwapInstructionsSchema>,
  req: TradeRequest,
  raw: JupQuote,
  expected: ExpectedAccounts,
): Instruction[] {
  if (si.otherInstructions.length) throw new Error("Unexpected extra Jupiter instructions");
  if (si.cleanupInstruction) throw new Error("Unexpected Jupiter cleanup instruction (SOL wrapping is disabled)");
  const out: Instruction[] = [];
  for (const ix of si.setupInstructions) {
    if (ix.programId !== ATA_PROGRAM) throw new Error(`Setup instruction targets unexpected program ${ix.programId}`);
    const [payer, , owner] = ix.accounts;
    if (payer?.pubkey !== expected.authority || owner?.pubkey !== expected.authority)
      throw new Error("Setup instruction creates an account not owned by the Asset Signer");
    out.push(toUmi(ix));
  }
  const sw = si.swapInstruction;
  if (sw.programId !== JUPITER_PROGRAM) throw new Error("Swap instruction is not Jupiter v6");
  const data = Buffer.from(sw.data, "base64");
  if (data.subarray(0, 8).toString("hex") !== ROUTE_DISCRIMINATOR) throw new Error("Only Jupiter `route` is accepted");
  const a = sw.accounts;
  const checks: Array<[boolean, string]> = [
    [a[1]?.pubkey === expected.authority && a[1]?.isSigner === true, "user authority must be the Asset Signer"],
    [a[2]?.pubkey === expected.sourceTokenAccount, "source must be the Asset Signer's input token account"],
    [a[3]?.pubkey === expected.destinationTokenAccount, "destination must be the Asset Signer's output token account"],
    [a[4]?.pubkey === JUPITER_PROGRAM, "no third-party destination account allowed"],
    [a[5]?.pubkey === req.outputMint, "destination mint mismatch"],
    [a[6]?.pubkey === JUPITER_PROGRAM, "platform fee account must be empty"],
    [a.filter((k) => k.isSigner).every((k) => k.pubkey === expected.authority), "only the Asset Signer may sign"],
  ];
  const tail = data.subarray(data.length - 19);
  const inAmount = tail.readBigUInt64LE(0);
  const quotedOut = tail.readBigUInt64LE(8);
  const slippage = tail.readUInt16LE(16);
  const platformFee = tail.readUInt8(18);
  checks.push(
    [inAmount === req.amountIn, `encoded in_amount ${inAmount} ≠ approved ${req.amountIn}`],
    [quotedOut === BigInt(raw.outAmount), "encoded quoted_out_amount differs from quote"],
    [slippage === raw.slippageBps && slippage <= requestedSlippageBps(req), `encoded slippage ${slippage}bps exceeds ${requestedSlippageBps(req)}bps`],
    [platformFee === 0, "platform fee must be zero"],
  );
  const failed = checks.filter(([ok]) => !ok).map(([, m]) => m);
  if (failed.length) throw new Error(`Rejected Jupiter instruction: ${failed.join("; ")}`);
  out.push(toUmi(sw));
  return out;
}

function toUmi(ix: z.infer<typeof JupIx>): Instruction {
  return {
    programId: publicKey(ix.programId),
    keys: ix.accounts.map((k) => ({ pubkey: publicKey(k.pubkey) as PublicKey, isSigner: k.isSigner, isWritable: k.isWritable })),
    data: new Uint8Array(Buffer.from(ix.data, "base64")),
  };
}
