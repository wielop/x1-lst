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
export const DIG_CONFIG_SEED = Buffer.from("dig_config");
export const DIG_SESSION_SEED = Buffer.from("dig_session");
export const MINT_AUTHORITY_SEED = Buffer.from("mint_authority");

export function roundPda(roundId: bigint): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(roundId);
  return PublicKey.findProgramAddressSync([ROUND_SEED, buf], PROGRAM_ID);
}

export function configPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
}

export function digConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([DIG_CONFIG_SEED], PROGRAM_ID);
}

export function digSessionPda(sessionId: bigint): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(sessionId);
  return PublicKey.findProgramAddressSync([DIG_SESSION_SEED, buf], PROGRAM_ID);
}

export function mintAuthorityPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([MINT_AUTHORITY_SEED], PROGRAM_ID);
}
