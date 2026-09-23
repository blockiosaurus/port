import { describe, expect, it } from "vitest";
import { createNoopSigner, publicKey } from "@metaplex-foundation/umi";
import { burnerId, composeWallets, EXTERNAL_ID, type Wallet } from "./wallets-model";

const w = (id: string, kind: Wallet["kind"], key: string): Wallet => ({ id, label: id, kind, signer: createNoopSigner(publicKey(key)) });
const A = w(burnerId(0), "burner", "11111111111111111111111111111111");
const B = w(burnerId(1), "burner", "So11111111111111111111111111111111111111112");
const X = w(EXTERNAL_ID, "external", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

describe("composeWallets", () => {
  it("shows burners on a local cluster and defaults to the first", () => {
    const r = composeWallets({ burners: [A, B], external: null, local: true, activeId: null });
    expect(r.wallets.map((x) => x.id)).toEqual([A.id, B.id]);
    expect(r.active?.id).toBe(A.id);
  });
  it("keeps the stored active burner", () => {
    expect(composeWallets({ burners: [A, B], external: null, local: true, activeId: B.id }).active?.id).toBe(B.id);
  });
  it("lists a connected wallet first, alongside burners on the fork", () => {
    const r = composeWallets({ burners: [A, B], external: X, local: true, activeId: EXTERNAL_ID });
    expect(r.wallets.map((x) => x.id)).toEqual([X.id, A.id, B.id]);
    expect(r.active?.id).toBe(X.id);
  });
  it("hides burners on live clusters", () => {
    const r = composeWallets({ burners: [A, B], external: X, local: false, activeId: A.id });
    expect(r.wallets.map((x) => x.id)).toEqual([X.id]);
    expect(r.active?.id).toBe(X.id);
  });
  it("has no wallet on a live cluster until one connects", () => {
    const r = composeWallets({ burners: [A, B], external: null, local: false, activeId: A.id });
    expect(r.wallets).toEqual([]);
    expect(r.active).toBeUndefined();
  });
  it("falls back to a burner after the external wallet disconnects", () => {
    expect(composeWallets({ burners: [A, B], external: null, local: true, activeId: EXTERNAL_ID }).active?.id).toBe(A.id);
  });
});
