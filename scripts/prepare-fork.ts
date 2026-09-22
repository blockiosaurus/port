/**
 * Builds the PORT demo environment: a local validator forked from Solana mainnet that contains
 * the real Core + MPL Agent programs, Token-2022, Jupiter, and the exact PreStocks pools the
 * demo strategy routes through. Nothing here spends real funds.
 *
 *   pnpm demo:fork:prepare   → .demo/fork/validator.sh, keys in .keys/, USDC faucet fixture
 *   pnpm demo:fork           → starts the validator on :28899
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { generateSigner, publicKey, type Instruction } from "@metaplex-foundation/umi";
import { findAssociatedTokenPda } from "@metaplex-foundation/mpl-toolbox";
import { makeUmi, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "@port/port-sdk";
import { DEMO_STRATEGY, JupiterTradeAdapter, USDC_MAINNET } from "@port/integrations";
import { collectAccounts, FORK_RPC, tokenAccountFixture, writeValidatorScript } from "./lib/fork";

const KEYS = ".keys";
const DIR = ".demo/fork";
const TREASURY_USDC = 1_000_000n * 1_000_000n;

async function loadOrCreateKey(name: string): Promise<string> {
  const path = `${KEYS}/${name}.json`;
  const umi = makeUmi(FORK_RPC);
  if (!existsSync(path)) {
    const s = generateSigner(umi);
    await writeFile(path, JSON.stringify(Array.from(s.secretKey)), { mode: 0o600 });
  }
  const kp = umi.eddsa.createKeypairFromSecretKey(new Uint8Array(JSON.parse(await readFile(path, "utf8"))));
  return kp.publicKey;
}

await mkdir(KEYS, { recursive: true, mode: 0o700 });
await mkdir(DIR, { recursive: true });
const treasury = await loadOrCreateKey("treasury");
const executive = await loadOrCreateKey("executive");

// Routes are pool-specific, not user-specific: quote with a throwaway authority and clone the pools.
const umi = makeUmi(FORK_RPC);
const probe = generateSigner(umi).publicKey;
const ata = (mint: string, program: string) => findAssociatedTokenPda(umi, { mint: publicKey(mint), owner: probe, tokenProgramId: publicKey(program) })[0];
const jup = new JupiterTradeAdapter({ onlyDirectRoutes: true });
const instructions: Instruction[] = [];
const alts = new Set<string>();
const routes: Record<string, string[]> = {};
for (const t of DEMO_STRATEGY.targets.filter((t) => t.mint !== USDC_MAINNET)) {
  const usdcAta = ata(USDC_MAINNET, TOKEN_PROGRAM);
  const tokAta = ata(t.mint, TOKEN_2022_PROGRAM);
  const buy = await jup.prepare({ inputMint: USDC_MAINNET, outputMint: t.mint, amountIn: 1_000_000_000n, slippageBps: 100, outputTransferFeeBps: 100 }, { authority: probe, sourceTokenAccount: usdcAta, destinationTokenAccount: tokAta });
  const sell = await jup.prepare({ inputMint: t.mint, outputMint: USDC_MAINNET, amountIn: buy.quote.minOutAmount / 2n, slippageBps: 100, inputTransferFeeBps: 100 }, { authority: probe, sourceTokenAccount: tokAta, destinationTokenAccount: usdcAta });
  for (const p of [buy, sell]) {
    instructions.push(...p.instructions);
    p.addressLookupTables.forEach((a) => alts.add(a));
  }
  routes[t.symbol] = [...buy.routeLabels, "/", ...sell.routeLabels];
  console.log(`${t.symbol}: buy ${buy.routeLabels.join("→")} | sell ${sell.routeLabels.join("→")}`);
}

const treasuryAta = findAssociatedTokenPda(umi, { mint: publicKey(USDC_MAINNET), owner: publicKey(treasury), tokenProgramId: publicKey(TOKEN_PROGRAM) })[0];
await writeFile(`${DIR}/treasury-usdc.json`, JSON.stringify(tokenAccountFixture(treasuryAta, USDC_MAINNET, treasury, TREASURY_USDC), null, 2));
const cloned = await collectAccounts(instructions, [...alts], [USDC_MAINNET, ...DEMO_STRATEGY.targets.map((t) => t.mint)], [probe]);
const info = await writeValidatorScript(`${DIR}/validator.sh`, `${DIR}/ledger`, cloned, [{ address: treasuryAta, file: `${DIR}/treasury-usdc.json` }]);
await writeFile(`${DIR}/env.json`, JSON.stringify({ preparedAt: new Date().toISOString(), forkSlot: info.slot, treasury, executive, routes }, null, 2));
console.log(`Fork ready: ${info.programs} programs, ${info.accounts} accounts, warp slot ${info.slot + 50}.`);
console.log(`Treasury ${treasury} (1,000,000 fork USDC) · Agent executive ${executive}`);
console.log(`Start it with: pnpm demo:fork`);
