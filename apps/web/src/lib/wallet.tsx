"use client";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, useWalletModal } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import type { EnvDto } from "./dto";
import { short } from "./format";

export type ClientEnv = EnvDto & { demo: { asset: string } | null };
const EnvContext = createContext<ClientEnv | null>(null);
export const useEnvContext = () => useContext(EnvContext);

/**
 * App-wide providers: the environment (fetched once from /api/env) and the Solana wallet adapter.
 * Wallet Standard wallets (Phantom, Solflare, Backpack, …) register themselves, so no adapter list is
 * needed. The wallet only signs; transactions are built and sent through the app's own umi RPC.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [env, setEnv] = useState<ClientEnv | null>(null);
  useEffect(() => {
    fetch("/api/env", { cache: "no-store" })
      .then((r) => r.json())
      .then(setEnv)
      .catch(() => {});
  }, []);
  // Only used by the adapter's ConnectionProvider contract; the app never calls useConnection.
  const endpoint = env?.rpcUrl ?? "http://127.0.0.1:8899";
  return (
    <EnvContext.Provider value={env}>
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={[]} autoConnect>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </EnvContext.Provider>
  );
}

/** Connect / disconnect a browser wallet, in the deed's own style. */
export function WalletButton() {
  const { wallet, publicKey, connected, connecting, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const name = wallet?.adapter.name;
  const label = useMemo(() => (connecting ? "Connecting…" : connected && publicKey ? `Disconnect ${name ?? ""}`.trim() : "Connect wallet"), [connecting, connected, publicKey, name]);
  return (
    <button
      className="btn btn-ghost !py-1 !text-[12px]"
      disabled={connecting}
      onClick={() => (connected ? disconnect().catch(() => {}) : setVisible(true))}
      title={connected && publicKey ? `${name}: ${publicKey.toBase58()}` : "Connect a Wallet Standard wallet (Phantom, Solflare, Backpack, …)"}
    >
      {connected && publicKey ? label : label}
      {connected && publicKey && <span className="font-mono text-ink-3">· {short(publicKey.toBase58(), 3)}</span>}
    </button>
  );
}
