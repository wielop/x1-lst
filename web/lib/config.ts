import { PublicKey } from "@solana/web3.js";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.x1.xyz";
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ?? "7oa9Ho5HqYEyyBmRmwh7gnUEtDjkKPGaGFcomXkDiwuy",
);

export const TOTAL_TILES = 25;
export const GRID_SIZE = 5;
export const MULT_SCALE = 1_000_000;

export const CONFIG_SEED = Buffer.from("config");
export const VAULT_SEED = Buffer.from("vault");
export const ROUND_SEED = Buffer.from("round");

export function configPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
}

export function vaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED], PROGRAM_ID);
}

export function roundPda(roundId: bigint): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(roundId);
  return PublicKey.findProgramAddressSync([ROUND_SEED, buf], PROGRAM_ID);
}

/** Fair (zero-house-edge) hypergeometric multiplier, mirrors the on-chain formula. */
export function fairMultiplier(revealed: number, mines: number, totalTiles = TOTAL_TILES): number {
  let m = 1;
  for (let i = 0; i < revealed; i++) {
    m *= (totalTiles - i) / (totalTiles - i - mines);
  }
  return m;
}
