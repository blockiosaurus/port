import { resolve } from "node:path";
import type { NextConfig } from "next";

// Single source of configuration: the repo-root .env. Variables already set in the shell win,
// so `pnpm dev:fork` can point the app at the local fork without editing the file.
try {
  process.loadEnvFile(resolve(process.cwd(), "../../.env"));
} catch {}

const config: NextConfig = {
  devIndicators: false,
  // Do not write AGENTS.md/CLAUDE.md into the app on dev start.
  agentRules: false,
  transpilePackages: ["@port/shared", "@port/port-sdk", "@port/risk-engine", "@port/integrations"],
  serverExternalPackages: ["@meteora-ag/cp-amm-sdk", "@meteora-ag/dynamic-bonding-curve-sdk", "@coral-xyz/anchor"],
};
export default config;
