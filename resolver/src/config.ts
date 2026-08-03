import "dotenv/config";
import { PublicKey } from "@solana/web3.js";

export const RPC_URL = process.env.RPC_URL ?? "https://rpc.testnet.x1.xyz";
export const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "5ViMkjJFgjUD9tuouTpjZ3m86jyGH8iB6h3r4Dxa4BCe",
);
export const RESOLVER_KEYPAIR_PATH = process.env.RESOLVER_KEYPAIR_PATH ?? "../keys/resolver-testnet.json";
export const SEED_STORE_PATH = process.env.SEED_STORE_PATH ?? "./seed-store.json";

export const CONFIG_SEED = Buffer.from("config");
export const ROUND_SEED = Buffer.from("round");

export function roundPda(roundId: bigint): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(roundId);
  return PublicKey.findProgramAddressSync([ROUND_SEED, buf], PROGRAM_ID);
}

export function configPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
}
