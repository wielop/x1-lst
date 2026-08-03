"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { RPC_URL } from "@/lib/config";

import "@solana/wallet-adapter-react-ui/styles.css";

// No explicit adapter list: every wallet worth supporting (Phantom, Backpack,
// Solflare, ...) implements the Wallet Standard and auto-registers itself —
// listing legacy adapter classes here is no longer necessary.
export function WalletProviders({ children }: { children: React.ReactNode }) {
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
