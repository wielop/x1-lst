/**
 * One-time admin setup for $MINE staking v3 — multi-position lock/burn
 * (see the module comment above `open_burn` in programs/mines/src/lib.rs).
 * Replaces v2's initializeStakingPoolV2.ts — v2's PDAs (and whatever was
 * locked/burned under them) are simply left behind under different seeds,
 * per explicit go-ahead that testnet state doesn't need preserving.
 *
 * Lock tiers (duration -> weight multiplier): longer lock, same tokens,
 * bigger share of the reward pool — unchanged from v2.
 *
 * Burn tiers are new: same shape, but INVERTED (short duration -> high
 * multiplier, long -> low). Burn's token cost is already paid up front
 * regardless of chosen duration, so without the inversion there'd be no
 * real trade-off — everyone would always pick the longest duration AND
 * the biggest multiplier. The inversion makes it a genuine choice: a
 * short, strong burst vs. a longer, gentler one.
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
// Testnet-scale durations so the whole lock/expire cycle is actually
// testable in a session; a mainnet launch would use real day-scale values
// via the same admin instruction later.
const LOCK_TIERS = [
  { durationSeconds: 0, weightMultiplierBps: 10_000 }, // no lock, 1x
  { durationSeconds: 60, weightMultiplierBps: 15_000 }, // 1 min, 1.5x
  { durationSeconds: 300, weightMultiplierBps: 25_000 }, // 5 min, 2.5x
  { durationSeconds: 900, weightMultiplierBps: 40_000 }, // 15 min, 4x
];
// Confirmed values from the user: 1m -> 4.0x, 5m -> 2.5x, 15m -> 1.5x —
// exactly the lock tier durations, inverted multipliers.
const BURN_TIERS = [
  { durationSeconds: 60, weightMultiplierBps: 40_000 }, // 1 min, 4.0x
  { durationSeconds: 300, weightMultiplierBps: 25_000 }, // 5 min, 2.5x
  { durationSeconds: 900, weightMultiplierBps: 15_000 }, // 15 min, 1.5x
];
const SKIM_BPS = Number(process.env.SKIM_BPS ?? 100); // 1% of every wager, automatic

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const adminKeypair = loadKeypair(ADMIN_KEYPAIR_PATH);
  const wallet = new Wallet(adminKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(minesIdl, PROGRAM_ID, provider);

  const [config] = configPda();
  const [stakingPool] = PublicKey.findProgramAddressSync([Buffer.from("staking_pool_v3")], PROGRAM_ID);
  const [stakingAuthority] = PublicKey.findProgramAddressSync([Buffer.from("staking_authority_v3")], PROGRAM_ID);
  const [rewardVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_vault_v3")], PROGRAM_ID);
  const [stakeTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("stake_token_vault_v3")], PROGRAM_ID);

  const configAccount: any = await (program.account as any).config.fetch(config);

  const sig = await program.methods
    .initializeStakingPool(LOCK_TIERS, BURN_TIERS, SKIM_BPS)
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

  console.log(`staking pool v3 initialized (tx ${sig})`);
  console.log(`staking pool: ${stakingPool.toBase58()}`);
  console.log(`lock tiers:`, LOCK_TIERS.map((t) => `${t.durationSeconds}s -> ${t.weightMultiplierBps / 10000}x`));
  console.log(`burn tiers:`, BURN_TIERS.map((t) => `${t.durationSeconds}s -> ${t.weightMultiplierBps / 10000}x`));
  console.log(`auto skim: ${SKIM_BPS / 100}% of every wager`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
