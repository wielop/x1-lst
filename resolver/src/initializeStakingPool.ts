/**
 * One-time admin setup for $MINE staking. Run once, after the program
 * upgrade that added stake/unstake/claim_yield/fund_staking_rewards has
 * been deployed.
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
// 7-day lockup at launch — slows dump velocity without being punitive;
// tune-able only by redeploy today (no update instruction for this yet,
// deliberately simple for v1).
const STAKE_LOCKUP_SECONDS = Number(process.env.STAKE_LOCKUP_SECONDS ?? 7 * 24 * 60 * 60);

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const adminKeypair = loadKeypair(ADMIN_KEYPAIR_PATH);
  const wallet = new Wallet(adminKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(minesIdl, PROGRAM_ID, provider);

  const [config] = configPda();
  const [stakingPool] = PublicKey.findProgramAddressSync([Buffer.from("staking_pool")], PROGRAM_ID);
  const [stakingAuthority] = PublicKey.findProgramAddressSync([Buffer.from("staking_authority")], PROGRAM_ID);
  const [rewardVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_vault")], PROGRAM_ID);
  const [stakeTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("stake_token_vault")], PROGRAM_ID);

  const configAccount: any = await (program.account as any).config.fetch(config);

  const sig = await program.methods
    .initializeStakingPool(STAKE_LOCKUP_SECONDS)
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

  console.log(`staking pool initialized (tx ${sig})`);
  console.log(`staking pool: ${stakingPool.toBase58()}`);
  console.log(`stake token vault: ${stakeTokenVault.toBase58()}`);
  console.log(`reward vault: ${rewardVault.toBase58()}`);
  console.log(`lockup: ${STAKE_LOCKUP_SECONDS}s (${STAKE_LOCKUP_SECONDS / 86400} days)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
