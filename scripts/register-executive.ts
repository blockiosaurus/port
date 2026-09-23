/**
 * Registers the agent executive profile on the configured cluster (MPL Agent Tools).
 *
 * The executive key (.keys/executive.json by default) is the only key the server holds. It can
 * sign Core Execute for a PORT *only* while that PORT's owner has an active delegate record; it
 * can never transfer a PORT, change a mandate, or delegate to anyone else.
 *
 *   pnpm exec:register              # show status and what it would cost, change nothing
 *   pnpm exec:register --yes        # send the registration transaction
 *
 * On a live cluster the key must already hold SOL: this script never airdrops there.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createSignerFromKeypair, generateSigner, sol } from "@metaplex-foundation/umi";
import { safeFetchExecutiveProfileV1 } from "@metaplex-foundation/mpl-agent-registry";
import { ensureExecutive, findExecutiveProfile, makeUmi } from "@port/port-sdk";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:28899";
const CLUSTER = process.env.PORT_CLUSTER ?? "fork";
const NAME = process.env.EXECUTIVE_KEY_NAME ?? "executive";
const LOCAL = CLUSTER === "fork" || CLUSTER === "localnet";
const send = process.argv.includes("--yes");
const PROFILE_RENT = 1_169_280n; // ExecutiveProfileV1 rent-exempt minimum, measured on-chain

const path = `.keys/${NAME}.json`;
const umiBase = makeUmi(RPC);
if (!existsSync(path)) {
  if (!LOCAL && !send) throw new Error(`${path} does not exist. Re-run with --yes to generate a new executive key for ${CLUSTER}.`);
  await mkdir(".keys", { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(Array.from(generateSigner(umiBase).secretKey)), { mode: 0o600 });
  console.log(`generated ${path}`);
}
const signer = createSignerFromKeypair(umiBase, umiBase.eddsa.createKeypairFromSecretKey(new Uint8Array(JSON.parse(await readFile(path, "utf8")))));
const umi = makeUmi(RPC, signer);

const profile = findExecutiveProfile(umi, signer.publicKey);
const registered = Boolean(await safeFetchExecutiveProfileV1(umi, profile));
let balance = (await umi.rpc.getBalance(signer.publicKey)).basisPoints;

console.log(`cluster           ${CLUSTER} (${RPC})`);
console.log(`executive key     ${signer.publicKey}  (${path})`);
console.log(`executive profile ${profile}  ${registered ? "registered" : "not registered"}`);
console.log(`balance           ${Number(balance) / 1e9} SOL`);
if (!registered) console.log(`registration cost ~${Number(PROFILE_RENT) / 1e9} SOL rent + fees (reclaimed only by closing the profile)`);

if (registered) {
  console.log("\nNothing to do. Owners can delegate to this executive from the dashboard.");
  process.exit(0);
}
if (!send) {
  console.log("\nDry run. Re-run with --yes to register.");
  process.exit(0);
}
if (LOCAL && balance < 1_000_000_000n) {
  await umi.rpc.airdrop(signer.publicKey, sol(10));
  balance = (await umi.rpc.getBalance(signer.publicKey)).basisPoints;
}
if (balance < PROFILE_RENT + 10_000_000n)
  throw new Error(`Insufficient balance: fund ${signer.publicKey} with at least ${Number(PROFILE_RENT + 10_000_000n) / 1e9} SOL on ${CLUSTER} first.`);

const tx = await ensureExecutive(umi);
console.log(`\nregistered: ${tx?.signature ?? "already registered"}`);
console.log("Keep this key secret. Its only power is executing trades for PORTs that delegate to it; owners can revoke at any time.");
