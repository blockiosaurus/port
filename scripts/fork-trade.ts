/**
 * Phase 3 proof without spending real funds: a mainnet fork running a *real* Jupiter route
 * into a *real* PreStocks pool, signed by a PORT Asset Signer through Core Execute.
 *
 *   pnpm tsx scripts/fork-trade.ts prepare [OPENAI|ANTHROPIC|SPACEX] [usdc]
 *       → fetches a live Jupiter route for the future Asset Signer, validates it, and writes
 *         .demo/fork/{validator.sh,plan.json} plus a funded USDC token account fixture.
 *   bash .demo/fork/validator.sh          (validator on :28899 cloning every touched account)
 *   pnpm tsx scripts/fork-trade.ts run
 *       → creates the PORT with the pre-generated asset key and executes the route via Execute.
 *
 * The fork warps to the current mainnet slot so the cloned lookup table and pool state are valid.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createSignerFromKeypair, generateSigner, publicKey, sol, type Instruction } from "@metaplex-foundation/umi";
import { findAssociatedTokenPda } from "@metaplex-foundation/mpl-toolbox";
import { base58 } from "@metaplex-foundation/umi/serializers";
import { PortStrategySchema } from "@port/shared";
import {
  createPort, fetchLookupTables, fetchPortBalances, fetchPort, findPortSigner, guardedExecute, makeUmi,
  BASE_PROGRAM_ALLOWLIST, TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
} from "@port/port-sdk";
import { JUPITER_PROGRAM, JupiterTradeAdapter, PRESTOCKS } from "@port/integrations";

const DIR = ".demo/fork";
const MAINNET = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const FORK_RPC = "http://127.0.0.1:28899";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BUILTINS = new Set([
  "11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111", "Sysvar1nstructions1111111111111111111111111", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  TOKEN_PROGRAM, "AddressLookupTab1e1111111111111111111111111",
]);

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(MAINNET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await res.json()) as { result: T; error?: unknown };
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

/** 165-byte SPL token account: mint, owner, amount, no delegate, Initialized, not native. */
function tokenAccountFixture(address: string, mint: string, owner: string, amount: bigint) {
  const b = Buffer.alloc(165);
  Buffer.from(publicKeyBytes(mint)).copy(b, 0);
  Buffer.from(publicKeyBytes(owner)).copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  b.writeUInt8(1, 108);
  return { pubkey: address, account: { lamports: 2_039_280, data: [b.toString("base64"), "base64"], owner: TOKEN_PROGRAM, executable: false, rentEpoch: 0, space: 165 } };
}
const publicKeyBytes = (k: string) => base58.serialize(k);

async function prepare(symbol: string, usdc: string) {
  const token = PRESTOCKS.find((t) => t.symbol === symbol);
  if (!token) throw new Error(`unknown PreStock ${symbol}`);
  await mkdir(DIR, { recursive: true });
  const umi = makeUmi(FORK_RPC);
  const owner = generateSigner(umi);
  const asset = generateSigner(umi);
  const signer = findPortSigner(umi, asset.publicKey);
  const srcAta = findAssociatedTokenPda(umi, { mint: publicKey(USDC), owner: signer, tokenProgramId: TOKEN_PROGRAM })[0];
  const dstAta = findAssociatedTokenPda(umi, { mint: publicKey(token.mint), owner: signer, tokenProgramId: TOKEN_2022_PROGRAM })[0];
  const amountIn = BigInt(Math.round(Number(usdc) * 1e6));

  const jup = new JupiterTradeAdapter();
  const fee = 100; // PreStocks Token-2022 transfer fee (verified on-chain; re-read at runtime in the app)
  const buy = await jup.prepare(
    { inputMint: USDC, outputMint: token.mint, amountIn, slippageBps: 100, outputTransferFeeBps: fee },
    { authority: signer, sourceTokenAccount: srcAta, destinationTokenAccount: dstAta },
  );
  // Sell back half of the minimum the buy can deliver.
  const sellIn = buy.quote.minOutAmount / 2n;
  const sell = await jup.prepare(
    { inputMint: token.mint, outputMint: USDC, amountIn: sellIn, slippageBps: 100, inputTransferFeeBps: fee },
    { authority: signer, sourceTokenAccount: dstAta, destinationTokenAccount: srcAta },
  );
  const legs = [{ side: "buy", ...buy }, { side: "sell", ...sell }];
  for (const l of legs) console.log(`${l.side}: ${l.routeLabels.join(" → ")}; in ${l.quote.inAmount} net out ${l.quote.outAmount} (min ${l.quote.minOutAmount})`);

  // Every account the route touches, plus the lookup tables and their contents.
  const keys = new Set<string>();
  const alts = [...new Set(legs.flatMap((l) => l.addressLookupTables))];
  for (const l of legs) for (const ix of l.instructions) { keys.add(ix.programId); for (const k of ix.keys) keys.add(k.pubkey); }
  for (const alt of alts) keys.add(alt);
  const altAccounts = await rpc<{ value: Array<{ data: [string, string] } | null> }>("getMultipleAccounts", [alts, { encoding: "base64" }]);
  for (const a of altAccounts.value) {
    const data = Buffer.from(a!.data[0], "base64");
    for (let o = 56; o + 32 <= data.length; o += 32) keys.add(bs58encode(data.subarray(o, o + 32)));
  }
  // PORT itself: Core + MPL Agent identity/tools (all deployed on mainnet).
  for (const p of ["CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d", "1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p", "TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S"]) keys.add(p);
  keys.add(TOKEN_2022_PROGRAM);
  for (const k of [signer, srcAta, dstAta, owner.publicKey, asset.publicKey]) keys.delete(k);
  for (const k of BUILTINS) keys.delete(k);

  const list = [...keys];
  const programs: string[] = [];
  const accounts: string[] = [];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const res = await rpc<{ value: Array<{ executable: boolean; owner: string } | null> }>("getMultipleAccounts", [chunk, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    res.value.forEach((a, j) => {
      if (!a) return; // accounts that don't exist yet (e.g. created by the route) are skipped
      (a.executable ? programs : accounts).push(chunk[j]!);
    });
  }
  const { slot } = { slot: await rpc<number>("getSlot", [{ commitment: "confirmed" }]) };

  await writeFile(`${DIR}/usdc-ata.json`, JSON.stringify(tokenAccountFixture(srcAta, USDC, signer, 1_000n * 1_000_000n), null, 2));
  await writeFile(`${DIR}/plan.json`, JSON.stringify({
    symbol, amountIn: amountIn.toString(), owner: Array.from(owner.secretKey), asset: Array.from(asset.secretKey), signer, dstAta,
    legs: legs.map((l) => ({
      side: l.side, routeLabels: l.routeLabels, addressLookupTables: l.addressLookupTables,
      quote: { inAmount: l.quote.inAmount.toString(), outAmount: l.quote.outAmount.toString(), minOutAmount: l.quote.minOutAmount.toString() },
      instructions: l.instructions.map((ix) => ({ programId: ix.programId, keys: ix.keys, data: Buffer.from(ix.data).toString("base64") })),
    })),
  }, null, 2));
  const flags = [
    ...programs.map((p) => `--clone-upgradeable-program ${p}`),
    ...accounts.map((a) => `--clone ${a}`),
    `--account ${srcAta} ${DIR}/usdc-ata.json`,
  ];
  await writeFile(`${DIR}/validator.sh`, [
    "#!/usr/bin/env bash", "set -euo pipefail",
    `exec solana-test-validator --reset --quiet --ledger ${DIR}/ledger --url ${MAINNET} --warp-slot ${slot + 50} \\`,
    "  --rpc-port 28899 --faucet-port 29900 --gossip-port 28000 --dynamic-port-range 28001-28030 \\",
    ...flags.map((f, i) => `  ${f}${i < flags.length - 1 ? " \\" : ""}`),
  ].join("\n") + "\n");
  console.log(`wrote ${DIR}/validator.sh: ${programs.length} programs, ${accounts.length} accounts; warp slot ${slot + 50}`);
}

async function run() {
  const plan = JSON.parse(await readFile(`${DIR}/plan.json`, "utf8"));
  const base = makeUmi(FORK_RPC);
  const owner = createSignerFromKeypair(base, base.eddsa.createKeypairFromSecretKey(new Uint8Array(plan.owner)));
  const asset = createSignerFromKeypair(base, base.eddsa.createKeypairFromSecretKey(new Uint8Array(plan.asset)));
  const umi = makeUmi(FORK_RPC, owner);
  await base.rpc.airdrop(owner.publicKey, sol(10));
  const token = PRESTOCKS.find((t) => t.symbol === plan.symbol)!;
  const strategy = PortStrategySchema.parse({
    version: 1, name: "Fork Test", cashMint: USDC,
    targets: [{ mint: token.mint, symbol: token.symbol, weightBps: 5000 }, { mint: USDC, symbol: "USDC", weightBps: 5000 }],
    minCashWeightBps: 1000, rebalanceToleranceBps: 200, maxPositionWeightBps: 6000, maxTradeNavBps: 2000, maxPriceAgeSeconds: 120, maxSpreadBps: 150,
  });
  const created = await createPort(umi, { name: "Fork Test", uri: "https://port.local/p.json", strategy, agentRegistrationUri: "https://port.local/a.json", asset });
  if (created.signer !== plan.signer) throw new Error("signer mismatch");
  const port = await fetchPort(base, created.asset);
  console.log("before", (await fetchPortBalances(base, port)).map((b) => `${b.symbol}=${b.amount}`).join(" "));

  const results = [];
  for (const leg of plan.legs) {
    const before = await fetchPortBalances(base, port);
    const instructions: Instruction[] = leg.instructions.map((ix: { programId: string; keys: Instruction["keys"]; data: string }) => ({ ...ix, data: new Uint8Array(Buffer.from(ix.data, "base64")) }));
    const tx = await guardedExecute(umi, {
      asset: created.asset,
      instructions,
      allowedPrograms: [...BASE_PROGRAM_ALLOWLIST, JUPITER_PROGRAM],
      as: { authority: "owner" },
      computeUnits: 1_000_000,
      addressLookupTables: await fetchLookupTables(base, leg.addressLookupTables),
    });
    const after = await fetchPortBalances(base, port);
    const outSym = leg.side === "buy" ? plan.symbol : "USDC";
    const delta = (xs: typeof after, sym: string) => xs.find((b) => b.symbol === sym)!.amount;
    const received = delta(after, outSym) - delta(before, outSym);
    console.log(`${leg.side} after: ${after.map((b) => `${b.symbol}=${b.amount}`).join(" ")}`);
    results.push({ side: leg.side, signature: tx.signature, route: leg.routeLabels, netQuoted: leg.quote.outAmount, minOut: leg.quote.minOutAmount, received: received.toString() });
    if (received < BigInt(leg.quote.minOutAmount)) throw new Error(`${leg.side}: received below on-chain minimum`);
  }
  console.log(JSON.stringify({ asset: created.asset, assetSigner: created.signer, results }, null, 2));
  await writeFile(`${DIR}/result.json`, JSON.stringify({ asset: created.asset, assetSigner: created.signer, results }, null, 2));
}

const bs58encode = (b: Uint8Array) => base58.deserialize(b)[0];

const [cmd = "prepare", sym = "OPENAI", amt = "5"] = process.argv.slice(2);
if (cmd === "prepare") await prepare(sym, amt);
else if (cmd === "run") { if (!existsSync(`${DIR}/plan.json`)) throw new Error("run prepare first"); await run(); }
