import { writeFile } from "node:fs/promises";
import { base58 } from "@metaplex-foundation/umi/serializers";
import type { Instruction } from "@metaplex-foundation/umi";

export const MAINNET_RPC = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
export const FORK_RPC = "http://127.0.0.1:28899";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const PORT_PROGRAMS = [
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d", // Metaplex Core
  "1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p", // MPL Agent identity
  "TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S", // MPL Agent tools (execution delegation)
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022 at the mainnet version (PreStocks extensions)
];
const BUILTINS = new Set([
  "11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111", "Sysvar1nstructions1111111111111111111111111", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  TOKEN_PROGRAM, "AddressLookupTab1e1111111111111111111111111",
]);

export async function rpc<T>(method: string, params: unknown[], url = MAINNET_RPC): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await res.json()) as { result: T; error?: unknown };
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

/** 165-byte SPL token account: mint, owner, amount, no delegate, Initialized, not native. */
export function tokenAccountFixture(address: string, mint: string, owner: string, amount: bigint) {
  const b = Buffer.alloc(165);
  Buffer.from(base58.serialize(mint)).copy(b, 0);
  Buffer.from(base58.serialize(owner)).copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  b.writeUInt8(1, 108);
  return { pubkey: address, account: { lamports: 2_039_280, data: [b.toString("base64"), "base64"], owner: TOKEN_PROGRAM, executable: false, rentEpoch: 0, space: 165 } };
}

/** Collects program and data accounts (plus lookup-table contents) that must be cloned. */
export async function collectAccounts(instructions: Instruction[], lookupTables: string[], extra: string[] = [], exclude: string[] = []) {
  const keys = new Set<string>([...PORT_PROGRAMS, ...extra, ...lookupTables]);
  for (const ix of instructions) {
    keys.add(ix.programId);
    for (const k of ix.keys) keys.add(k.pubkey);
  }
  if (lookupTables.length) {
    const alts = await rpc<{ value: Array<{ data: [string, string] } | null> }>("getMultipleAccounts", [lookupTables, { encoding: "base64" }]);
    for (const a of alts.value) {
      if (!a) continue;
      const data = Buffer.from(a.data[0], "base64");
      for (let o = 56; o + 32 <= data.length; o += 32) keys.add(base58.deserialize(data.subarray(o, o + 32))[0]);
    }
  }
  for (const k of [...BUILTINS, ...exclude]) keys.delete(k);
  const list = [...keys];
  const programs: string[] = [];
  const accounts: string[] = [];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const res = await rpc<{ value: Array<{ executable: boolean; owner: string } | null> }>("getMultipleAccounts", [chunk, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    res.value.forEach((a, j) => {
      if (!a) return;
      // Only upgradeable-loader programs clone via --clone-upgradeable-program; legacy-loader
      // programs (e.g. SPL Memo) are plain executable accounts.
      (a.executable && a.owner === "BPFLoaderUpgradeab1e11111111111111111111111" ? programs : accounts).push(chunk[j]!);
    });
  }
  return { programs, accounts };
}

export async function writeValidatorScript(path: string, ledger: string, cloned: { programs: string[]; accounts: string[] }, fixtures: Array<{ address: string; file: string }>) {
  const slot = await rpc<number>("getSlot", [{ commitment: "confirmed" }]);
  const flags = [
    ...cloned.programs.map((p) => `--clone-upgradeable-program ${p}`),
    ...cloned.accounts.map((a) => `--clone ${a}`),
    ...fixtures.map((f) => `--account ${f.address} ${f.file}`),
  ];
  // Warp to the current mainnet slot so cloned lookup tables and pool clocks are valid.
  await writeFile(path, [
    "#!/usr/bin/env bash", "set -euo pipefail", 'cd "$(dirname "$0")/../.."',
    `exec solana-test-validator --reset --quiet --ledger ${ledger} --url ${MAINNET_RPC} --warp-slot ${slot + 50} \\`,
    "  --rpc-port 28899 --faucet-port 29900 --gossip-port 28000 --dynamic-port-range 28001-28030 \\",
    ...flags.map((f, i) => `  ${f}${i < flags.length - 1 ? " \\" : ""}`),
  ].join("\n") + "\n", { mode: 0o755 });
  return { slot, programs: cloned.programs.length, accounts: cloned.accounts.length };
}

export async function waitForRpc(url: string, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) })
      .then((r) => r.json())
      .then((j: any) => j.result === "ok")
      .catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`RPC ${url} not healthy after ${timeoutMs}ms`);
}

/** Demo scripts airdrop, use burner keys and a fixture treasury: refuse anything but a local ledger. */
export function assertLocalRpc(url: string): string {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`Refusing to run a fork demo script against ${host}; set FORK_RPC_URL to a local validator`);
  return url;
}
