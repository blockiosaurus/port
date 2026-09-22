import type { PortActivity, PortStrategy, RiskDecision } from "@port/shared";

/** Wire types: every bigint is a decimal string. */
export type Big = string;

export type EnvDto = { cluster: string; rpcUrl: string; pythConfigured: boolean; devPriceFallback: boolean; executive: string | null; faucet: boolean };

export type PositionDto = {
  mint: string; symbol: string; decimals: number; amount: Big; priceE8: Big | null; valueE8: Big;
  weightBps: number; targetBps: number; driftBps: number;
};
export type PriceDto = {
  mint: string; symbol: string; priceE8: Big; confE8: Big; publishTime: number; source: string;
  referencePriceE8?: Big; referenceConfE8?: Big; referencePublishTime?: number; referenceSource?: string;
  volatilityBps?: number; marketSession?: string;
};
export type BalanceDto = { mint: string; symbol: string; decimals: number; amount: Big; tokenAccount: string; tokenAccountOwner: string | null };

export type SnapshotDto = {
  port: { asset: string; name: string; uri: string; owner: string; signer: string; updateAuthority: string; strategy: PortStrategy; agentIdentity: string | null };
  balances: BalanceDto[];
  prices: Record<string, PriceDto>;
  valuation: { navE8: Big; positions: PositionDto[]; unpriced: string[] };
  delegates: Array<{ record: string; executiveProfile: string; executiveAuthority: string }>;
  profiles: Record<string, { decimals: number; uiMultiplierE9: Big; transferFeeBps: number; paused: boolean; permanentDelegate: string | null }>;
  warnings: string[];
  fetchedAt: number;
};

export type InstructionDto = { programId: string; keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>; data: string };

export type TradeDto = {
  trade: { side: "buy" | "sell"; mint: string; symbol: string; notionalE8: Big; amountIn: Big; inputMint: string; outputMint: string; reasons: string[] };
  decision: RiskDecision;
  prepared?: {
    quote: { inAmount: Big; outAmount: Big; minOutAmount: Big; slippageBps: number; transferFeeBps?: number };
    routeLabels: string[];
    addressLookupTables: string[];
    instructions: InstructionDto[];
  };
  error?: string;
};

export type ProposalDto = { snapshot: SnapshotDto; plan: { withinTolerance: boolean; rationale: string }; trades: TradeDto[] };
export type PortViewDto = { env: EnvDto; snapshot: SnapshotDto; activity: PortActivity[] };
