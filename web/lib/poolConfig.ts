import { PublicKey } from "@solana/web3.js";

export type NetworkName = "testnet" | "mainnet";

interface NetworkConfig {
  rpcUrl: string;
  programId: PublicKey;
  poolAddress: PublicKey;
  poolMint: PublicKey;
}

// NOTE: mainnet is intentionally left unset until testnet validation is
// complete and the team explicitly signs off on going live. Do not deploy
// or point this app at mainnet before then.
const NETWORKS: Record<NetworkName, NetworkConfig | null> = {
  testnet: {
    rpcUrl: "https://rpc.testnet.x1.xyz",
    programId: new PublicKey("HjJ81j6LvguqZP17WwPrWihqpCqWYMqPdVCEDtDXDd23"),
    poolAddress: new PublicKey("9Ct35Dtu7Pnk2LXsKSeLyGupnvZpfxVDvvQ8X8biz6Ne"),
    poolMint: new PublicKey("6xsd6uzHZpWnaHWyWvEatF8qKPDaJ2MoH9FY1M3pyAcB"),
  },
  mainnet: null,
};

export const ACTIVE_NETWORK: NetworkName =
  (process.env.NEXT_PUBLIC_X1_NETWORK as NetworkName) || "testnet";

const config = NETWORKS[ACTIVE_NETWORK];
if (!config) {
  throw new Error(
    `X1 ${ACTIVE_NETWORK} pool is not configured yet. This app is testnet-only until the pool is validated and deployed to mainnet.`,
  );
}

export const POOL_CONFIG = config;
