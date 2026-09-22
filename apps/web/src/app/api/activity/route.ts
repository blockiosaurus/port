import { z } from "zod";
import { PortActivitySchema } from "@port/shared";
import { publicKey } from "@metaplex-foundation/umi";
import { findPortSigner, makeUmi } from "@port/port-sdk";
import { activity, errorJson, json, RPC_URL } from "@/lib/server";

export const dynamic = "force-dynamic";

const Body = PortActivitySchema.omit({ id: true, timestamp: true, status: true }).extend({ signature: z.string().min(64).max(100) });

/**
 * Records a browser-signed action only after confirming on-chain that the transaction
 * succeeded, was signed by the claimed actor, and touched the PORT asset.
 */
export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const res = await fetch(RPC_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [body.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] }),
    }).then((r) => r.json());
    const tx = res.result;
    if (!tx) throw new Error("Transaction not found or not yet confirmed");
    if (tx.meta?.err) throw new Error("Transaction failed on-chain");
    const keys: Array<{ pubkey: string; signer: boolean }> = tx.transaction.message.accountKeys;
    if (!keys.some((k) => k.pubkey === body.actor && k.signer)) throw new Error("Actor did not sign this transaction");
    const loaded = [...keys.map((k) => k.pubkey), ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
    // Deposits touch only the Asset Signer's token account; everything else touches the asset.
    const signer = findPortSigner(makeUmi(RPC_URL), publicKey(body.portAsset));
    if (!loaded.includes(body.portAsset) && !loaded.includes(signer)) throw new Error("Transaction does not involve this PORT");
    return json(await activity.append({ ...body, status: "confirmed" }));
  } catch (e) {
    return errorJson(e);
  }
}

export async function GET(req: Request) {
  const asset = new URL(req.url).searchParams.get("asset") ?? undefined;
  return json(await activity.list(asset));
}
