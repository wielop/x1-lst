import { PublicKey } from "@solana/web3.js";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.x1.xyz";
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ?? "5ViMkjJFgjUD9tuouTpjZ3m86jyGH8iB6h3r4Dxa4BCe",
);

export const TOTAL_TILES = 25;
export const GRID_SIZE = 5;
export const MULT_SCALE = 1_000_000;

export const CONFIG_SEED = Buffer.from("config");
export const VAULT_SEED = Buffer.from("vault");
export const ROUND_SEED = Buffer.from("round");
export const DIG_CONFIG_SEED = Buffer.from("dig_config");
export const DIG_SESSION_SEED = Buffer.from("dig_session");

export const DIG_TIER_LABELS = ["30s", "60s", "90s"] as const;

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

export function digConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([DIG_CONFIG_SEED], PROGRAM_ID);
}

export function digSessionPda(sessionId: bigint): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(sessionId);
  return PublicKey.findProgramAddressSync([DIG_SESSION_SEED, buf], PROGRAM_ID);
}

// v3: multi-position staking redesign (see the module comment above
// `open_burn` in lib.rs) — StakingPool's layout changed (burn_tiers +
// total_positions replace the old flat burn_weight_multiplier_bps) and
// the old single-slot-per-owner StakePosition was replaced entirely by
// Position (owner + a global counter, any number per wallet). All four
// seeds bumped together for a clean reset — old v2 testnet state is
// simply abandoned, nothing there was ever meant to be permanent.
export function stakingPoolPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("staking_pool_v3")], PROGRAM_ID);
}

export function stakingAuthorityPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("staking_authority_v3")], PROGRAM_ID);
}

export function rewardVaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("reward_vault_v3")], PROGRAM_ID);
}

export function stakeTokenVaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("stake_token_vault_v3")], PROGRAM_ID);
}

/** A single lock or burn position — owner + a global position_id counter,
 * so a wallet can hold any number of these concurrently. */
export function positionPda(owner: PublicKey, positionId: bigint): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(positionId);
  return PublicKey.findProgramAddressSync([Buffer.from("position_v1"), owner.toBuffer(), buf], PROGRAM_ID);
}

export function liquidityPoolPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("liquidity_pool")], PROGRAM_ID);
}

export function poolXntVaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("pool_xnt_vault")], PROGRAM_ID);
}

export function poolMineVaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("pool_mine_vault")], PROGRAM_ID);
}

export function poolAuthorityPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], PROGRAM_ID);
}

/** Fair (zero-house-edge) hypergeometric multiplier, mirrors the on-chain formula. */
export function fairMultiplier(revealed: number, mines: number, totalTiles = TOTAL_TILES): number {
  let m = 1;
  for (let i = 0; i < revealed; i++) {
    m *= (totalTiles - i) / (totalTiles - i - mines);
  }
  return m;
}
