/**
 * One-time admin setup for $MINE staking v2 (variable lock-duration tiers
 * + permanent lock-and-burn). Replaces v1's initializeStakingPool.ts —
 * v1's PDAs are simply left behind under different seeds.
 *
 * Lock tiers (duration -> weight multiplier): longer lock, same tokens,
 * bigger share of the reward pool. Burn multiplier is set higher than any
 * timed tier since it's permanent and irreversible.
 */
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "node:fs";
import { PROGRAM_ID, RPC_URL, configPda } from "./config.js";
import { minesIdl } from "./idl.js";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const ADMIN_KEYPAIR_PATH = process.env.ADMIN_KEYPAIR_PATH ?? "../keys/deployer-testnet.json";
// Testnet-scale durations so the whole lock/unlock cycle is actually
// testable in a session; a mainnet launch would use real day-scale values
// (e.g. 0 / 30d / 90d / 180d) via the same admin instruction later.
const LOCK_TIERS = [
  { durationSeconds: 0, weightMultiplierBps: 10_000 }, // no lock, 1x
  { durationSeconds: 60, weightMultiplierBps: 15_000 }, // 1 min, 1.5x
  { durationSeconds: 300, weightMultiplierBps: 25_000 }, // 5 min, 2.5x
  { durationSeconds: 900, weightMultiplierBps: 40_000 }, // 15 min, 4x
];
const BURN_WEIGHT_MULTIPLIER_BPS = Number(process.env.BURN_WEIGHT_MULTIPLIER_BPS ?? 60_000); // 6x, permanent
const SKIM_BPS = Number(process.env.SKIM_BPS ?? 100); // 1% of every wager, automatic

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const adminKeypair = loadKeypair(ADMIN_KEYPAIR_PATH);
  const wallet = new Wallet(adminKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(minesIdl, PROGRAM_ID, provider);

  const [config] = configPda();
  const [stakingPool] = PublicKey.findProgramAddressSync([Buffer.from("staking_pool_v2")], PROGRAM_ID);
  const [stakingAuthority] = PublicKey.findProgramAddressSync([Buffer.from("staking_authority_v2")], PROGRAM_ID);
  const [rewardVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_vault_v2")], PROGRAM_ID);
  const [stakeTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("stake_token_vault_v2")], PROGRAM_ID);

  const configAccount: any = await (program.account as any).config.fetch(config);

  const sig = await program.methods
    .initializeStakingPool(LOCK_TIERS, BURN_WEIGHT_MULTIPLIER_BPS, SKIM_BPS)
    .accounts({
      admin: adminKeypair.publicKey,
      config,
      stakingPool,
      stakingAuthority,
      rewardVault,
      mineMint: configAccount.mineMint,
      stakeTokenVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`staking pool v2 initialized (tx ${sig})`);
  console.log(`staking pool: ${stakingPool.toBase58()}`);
  console.log(`lock tiers:`, LOCK_TIERS.map((t) => `${t.durationSeconds}s -> ${t.weightMultiplierBps / 10000}x`));
  console.log(`burn multiplier: ${BURN_WEIGHT_MULTIPLIER_BPS / 10000}x (permanent)`);
  console.log(`auto skim: ${SKIM_BPS / 100}% of every wager`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
