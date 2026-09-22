import BN from "bn.js";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  ActivationType, BaseFeeMode, buildCurve, CollectFeeMode, DynamicBondingCurveClient, MigrationFeeOption, MigrationOption,
  TokenAuthorityOption, TokenDecimal, TokenType, deriveDbcPoolAddress, deriveTokenBadgeAddress, type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

export const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const DAMM_V2_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
/** xStocks NVIDIA (Backed). Token-2022, 8 decimals, no transfer fee, DBC token badge issued. */
export const NVDAX_MINT = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";

/**
 * The agent-token market design, with the reason for every number. Kept as data so the README,
 * UI and on-chain config are generated from one source.
 */
export const AGENT_MARKET_DESIGN = {
  name: "PORT Agent 001",
  symbol: "PORTA",
  quote: { mint: NVDAX_MINT, symbol: "NVDAx", decimals: 8 },
  totalSupply: 1_000_000_000,
  percentageSupplyOnMigration: 20,
  /** In NVDAx; ≈ $1.8k at ~$180/share, above Meteora's ~$750 minimum for stock-quoted pools. */
  migrationQuoteThreshold: 10,
  feeBps: 100,
  creatorTradingFeePercentage: 50,
  migratedPoolFeeOption: MigrationFeeOption.FixedBps100,
  rationale: {
    quote:
      "NVDAx (xStocks NVIDIA) is the quote asset: an AI-compute equity for an AI-private-markets operator. PreStocks cannot be DBC quotes (1% Token-2022 transfer fee); NVDAx carries a Meteora token badge and no fee.",
    curve:
      "Single-segment curve that sells 80% of supply before graduation and migrates the remaining 20% with the raised NVDAx, so price discovery happens in stock terms and the post-migration pool opens near the final curve price.",
    fee: "Flat 1% fee collected in the quote token, so the operator treasury accrues NVDA exposure rather than its own token. 50% of trading fees go to the creator (agent treasury), 50% to the partner.",
    graduation: "Graduates at 10 NVDAx raised into a DAMM v2 pool with a fixed 1% fee; liquidity is permanently locked (no rug path).",
    authority: "Immutable token metadata and mint authority: the operator cannot mint more tokens after launch.",
  },
} as const;

export function agentCurveConfig(): ConfigParameters {
  const d = AGENT_MARKET_DESIGN;
  return buildCurve({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.EIGHT,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: d.totalSupply,
      leftover: 0,
    },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: d.feeBps, endingFeeBps: d.feeBps, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: d.creatorTradingFeePercentage,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: d.migratedPoolFeeOption, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 50, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 50, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: d.percentageSupplyOnMigration,
    migrationQuoteThreshold: d.migrationQuoteThreshold,
  });
}

/** Fetch pool + config; the IDL types the pool as `{ poolState }`, the runtime may return either. */
async function load(client: DynamicBondingCurveClient, pool: PublicKey) {
  const raw = await client.state.getPool(pool);
  if (!raw) throw new Error(`DBC pool ${pool.toBase58()} not found`);
  const virtualPool = raw;
  const state = ((raw as unknown as { poolState?: unknown }).poolState ?? raw) as any;
  const config = await client.state.getPoolConfig(state.config);
  if (!config) throw new Error("DBC pool config not found");
  return { virtualPool, state, config };
}

export type AgentMarket = { config: string; pool: string; baseMint: string; quoteMint: string; feeClaimer: string; signatures: Record<string, string> };

/**
 * Creates the DBC config (partner = agent operator) and the agent-token pool in one transaction.
 * Creator fees and leftovers route to the agent's operating treasury.
 */
export async function createAgentMarket(connection: Connection, operator: Keypair, treasury: PublicKey, uri: string): Promise<AgentMarket> {
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const config = Keypair.generate();
  const baseMint = Keypair.generate();
  const quoteMint = new PublicKey(AGENT_MARKET_DESIGN.quote.mint);
  const tx: Transaction = await client.partner.createConfigAndPool({
    ...agentCurveConfig(),
    config: config.publicKey,
    feeClaimer: treasury,
    leftoverReceiver: treasury,
    quoteMint,
    payer: operator.publicKey,
    tokenBadge: deriveTokenBadgeAddress(quoteMint),
    preCreatePoolParam: { name: AGENT_MARKET_DESIGN.name, symbol: AGENT_MARKET_DESIGN.symbol, uri, poolCreator: operator.publicKey, baseMint: baseMint.publicKey },
  });
  const sig = await sendAndConfirmTransaction(connection, tx, [operator, config, baseMint], { commitment: "confirmed" });
  const pool = deriveDbcPoolAddress(quoteMint, baseMint.publicKey, config.publicKey);
  return { config: config.publicKey.toBase58(), pool: pool.toBase58(), baseMint: baseMint.publicKey.toBase58(), quoteMint: quoteMint.toBase58(), feeClaimer: treasury.toBase58(), signatures: { createConfigAndPool: sig } };
}

/** Buys the agent token with NVDAx on the curve, with a quoted minimum out. */
export async function buyAgentToken(connection: Connection, buyer: Keypair, pool: PublicKey, quoteAmount: bigint, slippageBps = 100) {
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const { virtualPool, config } = await load(client, pool);
  const slot = await connection.getSlot();
  const time = await connection.getBlockTime(slot);
  const quote = client.pool.swapQuote({
    virtualPool, config, swapBaseForQuote: false, amountIn: new BN(quoteAmount.toString()), slippageBps, hasReferral: false,
    eligibleForFirstSwapWithMinFee: false, currentPoint: new BN(time ?? Math.floor(Date.now() / 1000)),
  });
  const tx = await client.pool.swap({ owner: buyer.publicKey, pool, amountIn: new BN(quoteAmount.toString()), minimumAmountOut: quote.minimumAmountOut, swapBaseForQuote: false, referralTokenAccount: null });
  const sig = await sendAndConfirmTransaction(connection, tx, [buyer], { commitment: "confirmed" });
  return { signature: sig, expectedOut: quote.outputAmount?.toString?.() ?? String(quote.outputAmount), minimumOut: quote.minimumAmountOut.toString() };
}

export type AgentMarketState = {
  pool: string; baseMint: string; quoteMint: string; quoteReserve: string; baseReserve: string; sqrtPrice: string; isMigrated: boolean;
  migrationQuoteThreshold: string; progressBps: number; partnerQuoteFee: string; creatorQuoteFee: string;
};

export async function readAgentMarket(connection: Connection, pool: PublicKey): Promise<AgentMarketState> {
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const { state, config } = await load(client, pool);
  const threshold = BigInt(config.migrationQuoteThreshold.toString());
  const quote = BigInt(state.quoteReserve.toString());
  return {
    pool: pool.toBase58(),
    baseMint: state.baseMint.toBase58(),
    quoteMint: config.quoteMint.toBase58(),
    quoteReserve: quote.toString(),
    baseReserve: state.baseReserve.toString(),
    sqrtPrice: state.sqrtPrice.toString(),
    isMigrated: Boolean(state.isMigrated),
    migrationQuoteThreshold: threshold.toString(),
    progressBps: threshold > 0n ? Number((quote * 10_000n) / threshold) : 0,
    partnerQuoteFee: state.partnerQuoteFee.toString(),
    creatorQuoteFee: state.creatorQuoteFee.toString(),
  };
}
