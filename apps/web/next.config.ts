import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@port/shared", "@port/port-sdk", "@port/risk-engine", "@port/integrations"],
  serverExternalPackages: ["@meteora-ag/cp-amm-sdk", "@meteora-ag/dynamic-bonding-curve-sdk", "@coral-xyz/anchor"],
};
export default config;
