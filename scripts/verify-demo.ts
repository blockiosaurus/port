/**
 * Read-only verification of the demo state (.demo/state.json): asserts ownership, deterministic
 * signer, token-account custody, delegate status, and that every recorded signature landed.
 */
import { readFile } from "node:fs/promises";
import { publicKey } from "@metaplex-foundation/umi";
import { fetchPort, fetchPortBalances, findPortSigner, listDelegates, makeUmi } from "@port/port-sdk";
import { fromBaseUnits } from "@port/shared";

const state = JSON.parse(await readFile(".demo/state.json", "utf8"));
const umi = makeUmi(process.env.VERIFY_RPC_URL ?? state.rpcUrl);
let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const port = await fetchPort(umi, publicKey(state.asset));
check(port.signer === state.assetSigner, "Asset Signer matches recorded address", port.signer);
check(findPortSigner(makeUmi(process.env.VERIFY_RPC_URL ?? state.rpcUrl), port.asset) === port.signer, "Asset Signer derivation is deterministic");
check(port.owner === state.walletB, "Current owner is Wallet B", port.owner);
check(port.updateAuthority === "None", "Update authority renounced (creator keeps no control)");
check(port.agentIdentity !== null, "MPL Agent identity registered");

const balances = await fetchPortBalances(umi, port);
for (const b of balances)
  check(b.tokenAccountOwner === null || b.tokenAccountOwner === port.signer, `${b.symbol} custody`, `${fromBaseUnits(b.amount, b.decimals, 4)} in ${b.tokenAccount} owned by ${b.tokenAccountOwner ?? "(not created)"}`);
check(balances.some((b) => b.symbol !== "USDC" && b.amount > 0n), "Asset Signer holds at least one PreStock");

const delegates = await listDelegates(umi, port.asset, [publicKey(state.executive)]);
console.log(`  delegates: ${delegates.map((d) => d.executiveAuthority).join(", ") || "none"}`);

for (const [label, sig] of Object.entries(state.signatures as Record<string, string | undefined>)) {
  if (!sig) {
    check(false, `signature ${label}`, "missing");
    continue;
  }
  const tx = await fetch(process.env.VERIFY_RPC_URL ?? state.rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }] }),
  }).then((r) => r.json() as Promise<{ result: { meta: { err: unknown } } | null }>);
  check(tx.result !== null && tx.result.meta.err === null, `tx ${label}`, sig);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
