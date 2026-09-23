import type { Signer } from "@metaplex-foundation/umi";

/** One identity the browser can sign with: a fork-only burner keypair, or a Wallet Standard wallet. */
export type Wallet = { id: string; label: string; kind: "burner" | "external"; signer: Signer };

export const EXTERNAL_ID = "external";
export const burnerId = (i: number) => `burner:${i}`;

/**
 * Combines the burners with the connected wallet into the list the header shows.
 * Burners exist only on local clusters (fork/localnet); a connected wallet is listed first.
 * `activeId` that is not in the list (e.g. the wallet disconnected) falls back to the first entry.
 */
export function composeWallets({ burners, external, local, activeId }: { burners: Wallet[]; external: Wallet | null; local: boolean; activeId: string | null }): {
  wallets: Wallet[];
  active: Wallet | undefined;
} {
  const wallets = [...(external ? [external] : []), ...(local ? burners : [])];
  const active = wallets.find((w) => w.id === activeId) ?? wallets[0];
  return { wallets, active };
}
