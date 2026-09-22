/**
 * Launches the agent's market on the mainnet fork with the real Meteora DBC program:
 *   1. the treasury acquires NVDAx (xStocks NVIDIA) through a real Jupiter route,
 *   2. the agent operator creates an NVDAx-quoted DBC config + pool for "PORT Agent 001",
 *   3. a community buyer buys the agent token with NVDAx on the curve.
 * Writes .demo/agent-market.json. The token is a market for the operator, not a claim on any PORT.
 */
import { readFile, writeFile } from "node:fs/promises";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createSignerFromKeypair, publicKey, sol, transactionBuilder, type Instruction } from "@metaplex-foundation/umi";
import { fetchAddressLookupTable, setComputeUnitLimit } from "@metaplex-foundation/mpl-toolbox";
import { makeUmi, send } from "@port/port-sdk";
import { AGENT_MARKET_DESIGN, buyAgentToken, createAgentMarket, readAgentMarket } from "@port/integrations";
import { DISCLAIMER } from "@port/shared";
import { FORK_RPC, waitForRpc } from "./lib/fork";

const RPC = process.env.RPC_URL ?? FORK_RPC;
await waitForRpc(RPC, 30_000);
const secret = async (name: string) => new Uint8Array(JSON.parse(await readFile(`.keys/${name}.json`, "utf8")));
const treasuryKp = Keypair.fromSecretKey(await secret("treasury"));
const operatorKp = Keypair.fromSecretKey(await secret("executive"));
const umiBase = makeUmi(RPC);
const treasury = createSignerFromKeypair(umiBase, umiBase.eddsa.createKeypairFromSecretKey(await secret("treasury")));
const tu = makeUmi(RPC, treasury);
for (const k of [treasuryKp.publicKey, operatorKp.publicKey]) await umiBase.rpc.airdrop(publicKey(k.toBase58()), sol(10));

// 1. Treasury buys NVDAx with fork USDC through the Jupiter route pinned at fork preparation.
const pinned = JSON.parse(await readFile(".demo/fork/nvdax-swap.json", "utf8")) as { routeLabels: string[]; addressLookupTables: string[]; instructions: Array<{ programId: string; keys: Instruction["keys"]; data: string }> };
const swap = { routeLabels: pinned.routeLabels, instructions: pinned.instructions.map((ix): Instruction => ({ ...ix, programId: publicKey(ix.programId), data: new Uint8Array(Buffer.from(ix.data, "base64")) })) };

const tables = await Promise.all(pinned.addressLookupTables.map(async (a) => {
  const t = await fetchAddressLookupTable(tu, publicKey(a));
  return { publicKey: t.publicKey, addresses: t.addresses };
}));
let b = transactionBuilder().add(setComputeUnitLimit(tu, { units: 600_000 }));
for (const ix of swap.instructions) b = b.add({ instruction: ix, signers: [treasury], bytesCreatedOnChain: 0 });
const nvdaBuy = await send(tu, b.setAddressLookupTables(tables));
console.log(`treasury bought NVDAx via ${swap.routeLabels.join("→")}: ${nvdaBuy.signature}`);

// 2. Operator creates the NVDAx-quoted bonding curve for the agent token.
const connection = new Connection(RPC, "confirmed");
const market = await createAgentMarket(connection, operatorKp, operatorKp.publicKey, "https://port.markets/agent-001-token.json");
console.log(`agent market created: pool ${market.pool}, token ${market.baseMint}\n  ${market.signatures.createConfigAndPool}`);

// 3. A community buyer (the treasury here) buys the agent token with 0.5 NVDAx.
const buy = await buyAgentToken(connection, treasuryKp, new PublicKey(market.pool), 50_000_000n);
console.log(`bought ${AGENT_MARKET_DESIGN.symbol} with 0.5 NVDAx: ${buy.signature}`);

const state = await readAgentMarket(connection, new PublicKey(market.pool));
const out = { ...market, signatures: { ...market.signatures, nvdaxAcquire: nvdaBuy.signature, firstBuy: buy.signature }, design: AGENT_MARKET_DESIGN, state, disclaimer: DISCLAIMER, cluster: "fork", createdAt: new Date().toISOString() };
await writeFile(".demo/agent-market.json", JSON.stringify(out, null, 2));
console.log(`progress to graduation: ${(state.progressBps / 100).toFixed(2)}% · creator fees accrued (NVDAx raw): ${state.creatorQuoteFee}`);
