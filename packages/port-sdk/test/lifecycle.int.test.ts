/**
 * Phase 0/1 proof against real Core + MPL Agent programs (localnet loaded with devnet builds).
 * Run `scripts/localnet.sh` first; set RPC_URL to target another cluster.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { generateSigner, publicKey, sol, transactionBuilder, type Signer, type Umi } from "@metaplex-foundation/umi";
import { createMint, createIdempotentAssociatedToken, findAssociatedTokenPda, mintTokensTo } from "@metaplex-foundation/mpl-toolbox";
import { PortStrategySchema } from "@port/shared";
import {
  BASE_PROGRAM_ALLOWLIST, LOCALNET_RPC, PortError, createPort, delegateExecution, depositToPort, ensureExecutive,
  fetchDelegate, fetchMintInfo, fetchPort, fetchPortBalances, findPortSigner, guardedExecute, buildGuardedExecute,
  listDelegates, makeUmi, revokeExecution, send, signerTokenTransferIx, transferPort,
} from "../src";

const RPC = process.env.RPC_URL ?? LOCALNET_RPC;
const up = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) })
  .then((r) => r.ok)
  .catch(() => false);

describe.skipIf(!up)("PORT lifecycle on real programs", () => {
  const base = makeUmi(RPC);
  const wallet = () => {
    const s = generateSigner(base);
    return { s, umi: makeUmi(RPC, s) };
  };
  const A = wallet(), B = wallet(), EXEC = wallet(), STRANGER = wallet();
  let usdc: Signer;
  let asset: ReturnType<typeof publicKey>;
  const sigs: Record<string, string> = {};

  const withdrawIx = async (umi: Umi, to: Signer, amount: bigint) => {
    const info = await fetchMintInfo(umi, usdc.publicKey);
    await send(umi, createIdempotentAssociatedToken(umi, { mint: usdc.publicKey, owner: to.publicKey, ata: findAssociatedTokenPda(umi, { mint: usdc.publicKey, owner: to.publicKey }) }));
    return signerTokenTransferIx(umi, { signer: findPortSigner(umi, asset) }, info, to.publicKey, amount);
  };
  const tryExec = async (umi: Umi, to: Signer, as: Parameters<typeof buildGuardedExecute>[1]["as"]) => {
    // Skip client-side guards to prove the *on-chain* program rejects.
    const ixs = await withdrawIx(umi, to, 1_000n);
    return send(umi, buildGuardedExecute(umi, { asset, instructions: ixs, allowedPrograms: BASE_PROGRAM_ALLOWLIST, as }));
  };

  beforeAll(async () => {
    for (const w of [A, B, EXEC, STRANGER]) await base.rpc.airdrop(w.s.publicKey, sol(5));
    usdc = generateSigner(base);
    const ata = findAssociatedTokenPda(base, { mint: usdc.publicKey, owner: A.s.publicKey });
    await send(A.umi, transactionBuilder()
      .add(createMint(A.umi, { mint: usdc, decimals: 6 }))
      .add(createIdempotentAssociatedToken(A.umi, { mint: usdc.publicKey, owner: A.s.publicKey, ata }))
      .add(mintTokensTo(A.umi, { mint: usdc.publicKey, token: ata, amount: 10_000_000_000n })));
  }, 60_000);

  it("creates a PORT with sealed update authority and a deterministic signer", async () => {
    const strategy = PortStrategySchema.parse({
      version: 1, name: "Test Fund", targets: [{ mint: usdc.publicKey, symbol: "USDC", weightBps: 10_000 }], cashMint: usdc.publicKey,
      minCashWeightBps: 0, rebalanceToleranceBps: 100, maxPositionWeightBps: 10_000, maxTradeNavBps: 1000, maxPriceAgeSeconds: 60, maxSpreadBps: 100,
    });
    const res = await createPort(A.umi, { name: "Test Fund", uri: "https://example.com/p.json", strategy, agentRegistrationUri: "https://example.com/a.json" });
    asset = res.asset;
    sigs.create = res.signature;
    const port = await fetchPort(base, asset);
    expect(port.owner).toBe(A.s.publicKey);
    expect(port.updateAuthority).toBe("None");
    expect(port.agentIdentity).not.toBeNull();
    expect(port.signer).toBe(res.signer);
    expect(findPortSigner(makeUmi(RPC), asset)).toBe(res.signer); // any client, same PDA
    expect(port.strategy.name).toBe("Test Fund");
  });

  it("deposits into token accounts owned by the Asset Signer", async () => {
    const port = await fetchPort(base, asset);
    sigs.deposit = (await depositToPort(A.umi, port, usdc.publicKey, 5_000_000_000n)).signature;
    const [bal] = await fetchPortBalances(base, port);
    expect(bal!.amount).toBe(5_000_000_000n);
    expect(bal!.tokenAccountOwner).toBe(port.signer);
  });

  it("owner executes; stranger is rejected on-chain", async () => {
    sigs.ownerExecute = (await tryExec(A.umi, A.s, { authority: "owner" })).signature;
    await expect(tryExec(STRANGER.umi, STRANGER.s, { authority: "owner" })).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  it("client guard refuses non-allowlisted programs and non-owners", async () => {
    const ixs = await withdrawIx(A.umi, A.s, 1n);
    await expect(guardedExecute(A.umi, { asset, instructions: ixs, allowedPrograms: [], as: { authority: "owner" } })).rejects.toBeInstanceOf(PortError);
    await expect(guardedExecute(STRANGER.umi, { asset, instructions: ixs, allowedPrograms: BASE_PROGRAM_ALLOWLIST, as: { authority: "owner" } }))
      .rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  it("delegates execution to a registered executive", async () => {
    await ensureExecutive(EXEC.umi);
    sigs.delegate = (await delegateExecution(A.umi, asset, EXEC.s.publicKey)).signature;
    expect(await fetchDelegate(base, asset, EXEC.s.publicKey)).toMatchObject({ executiveAuthority: EXEC.s.publicKey });
    sigs.delegateExecute = (await tryExec(EXEC.umi, EXEC.s, { authority: "delegate" })).signature;
    // Without the record the program does not recognize the delegate.
    await expect(tryExec(EXEC.umi, EXEC.s, { authority: "owner" })).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  it("transfers ownership without moving the portfolio", async () => {
    const before = await fetchPort(base, asset);
    const balBefore = await fetchPortBalances(base, before);
    sigs.transfer = (await transferPort(A.umi, asset, B.s.publicKey)).signature;
    const after = await fetchPort(base, asset);
    expect(after.owner).toBe(B.s.publicKey);
    expect(after.signer).toBe(before.signer);
    expect(after.strategy).toEqual(before.strategy);
    expect(await fetchPortBalances(base, after)).toEqual(balBefore);
  });

  it("new owner executes; old owner cannot", async () => {
    await expect(tryExec(A.umi, A.s, { authority: "owner" })).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    sigs.newOwnerExecute = (await tryExec(B.umi, B.s, { authority: "owner" })).signature;
  });

  it("delegation PERSISTS across transfer until the new owner revokes it", async () => {
    const delegates = await listDelegates(base, asset, [EXEC.s.publicKey]);
    expect(delegates.map((d) => d.executiveAuthority)).toEqual([EXEC.s.publicKey]);
    await tryExec(EXEC.umi, EXEC.s, { authority: "delegate" });
    sigs.revoke = (await revokeExecution(B.umi, asset, EXEC.s.publicKey)).signature;
    await expect(tryExec(EXEC.umi, EXEC.s, { authority: "delegate" })).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(await fetchDelegate(base, asset, EXEC.s.publicKey)).toBeNull();
    console.log("PORT lifecycle signatures", { asset, ...sigs });
  });
});
