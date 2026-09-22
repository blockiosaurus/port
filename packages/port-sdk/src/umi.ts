import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { signerIdentity, type Signer, type Umi } from "@metaplex-foundation/umi";
import { mplCore } from "@metaplex-foundation/mpl-core";
import { mplToolbox } from "@metaplex-foundation/mpl-toolbox";
import { mplAgentIdentity, mplAgentTools } from "@metaplex-foundation/mpl-agent-registry";
import type { Cluster } from "@port/shared";

export const LOCALNET_RPC = "http://127.0.0.1:18899";

/**
 * A fresh Umi per wallet. `Umi.use()` mutates in place, so sharing one instance across
 * signers silently makes every "wallet" the last identity installed.
 */
export function makeUmi(rpcUrl: string, signer?: Signer): Umi {
  const umi = createUmi(rpcUrl, "confirmed").use(mplCore()).use(mplToolbox()).use(mplAgentIdentity()).use(mplAgentTools());
  return signer ? umi.use(signerIdentity(signer)) : umi;
}

export function clusterFromRpc(rpcUrl: string): Cluster {
  if (/devnet/.test(rpcUrl)) return "devnet";
  if (/127\.0\.0\.1|localhost/.test(rpcUrl)) return "localnet";
  return "mainnet-beta";
}
