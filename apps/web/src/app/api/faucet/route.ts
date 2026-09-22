import { z } from "zod";
import { publicKey, sol, transactionBuilder } from "@metaplex-foundation/umi";
import { createIdempotentAssociatedToken, findAssociatedTokenPda, transferTokensChecked } from "@metaplex-foundation/mpl-toolbox";
import { makeUmi, send } from "@port/port-sdk";
import { USDC_MAINNET } from "@port/integrations";
import { errorJson, IS_LOCAL, json, RPC_URL, treasury } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Fork/localnet only: SOL airdrop plus fork USDC from the demo treasury. Never on a live cluster. */
export async function POST(req: Request) {
  try {
    if (!IS_LOCAL) return json({ error: "Faucet disabled on live clusters" }, { status: 403 });
    const t = treasury();
    if (!t) throw new Error("Treasury key missing; run pnpm demo:fork:prepare");
    const { owner, usdc } = z.object({ owner: z.string(), usdc: z.number().int().min(1).max(50_000) }).parse(await req.json());
    const umi = makeUmi(RPC_URL, t);
    await umi.rpc.airdrop(publicKey(owner), sol(5));
    const mint = publicKey(USDC_MAINNET);
    const dest = findAssociatedTokenPda(umi, { mint, owner: publicKey(owner) })[0];
    const tx = await send(umi, transactionBuilder()
      .add(createIdempotentAssociatedToken(umi, { mint, owner: publicKey(owner), ata: dest }))
      .add(transferTokensChecked(umi, { source: findAssociatedTokenPda(umi, { mint, owner: t.publicKey })[0], destination: dest, mint, amount: BigInt(usdc) * 1_000_000n, decimals: 6 })));
    return json({ signature: tx.signature });
  } catch (e) {
    return errorJson(e);
  }
}
