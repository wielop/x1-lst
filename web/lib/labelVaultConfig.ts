import { PublicKey } from "@solana/web3.js";

/**
 * Underlying pools available to allocate into when creating a Label.
 * Testnet only for now — these are our own two stake-pool instances,
 * standing in for real rXNT/pXNT (which only exist on X1 mainnet; CPI can't
 * cross clusters, so there's nothing to test against here yet). Swap this
 * list for the real addresses before ever pointing at mainnet.
 */
export interface AvailablePool {
  address: PublicKey;
  label: string;
  symbol: string;
}

export const AVAILABLE_POOLS: AvailablePool[] = [
  {
    address: new PublicKey("9Ct35Dtu7Pnk2LXsKSeLyGupnvZpfxVDvvQ8X8biz6Ne"),
    label: "X1 Liquid Staking (testnet, stand-in for rXNT)",
    symbol: "tLST1",
  },
  {
    address: new PublicKey("9SA2Xsqn5BbihiswScziKaGWmjr6KAByqb1emEsnC1fW"),
    label: "Second testnet pool (stand-in for pXNT)",
    symbol: "tLST2",
  },
];
