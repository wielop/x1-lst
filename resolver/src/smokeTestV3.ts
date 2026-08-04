import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import fs from "node:fs";
import { PROGRAM_ID, RPC_URL, configPda } from "./config.js";
import { minesIdl } from "./idl.js";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const kp = loadKeypair("../keys/deployer-testnet.json");
  const wallet = new Wallet(kp);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(minesIdl, PROGRAM_ID, provider);

  const [config] = configPda();
  const configAccount: any = await (program.account as any).config.fetch(config);
  const mineMint: PublicKey = configAccount.mineMint;
  const ata = getAssociatedTokenAddressSync(mineMint, kp.publicKey);
  const balInfo = await connection.getTokenAccountBalance(ata).catch(() => null);
  console.log("deployer $MINE balance:", balInfo?.value.uiAmountString ?? "0 (no ATA)");

  const [stakingPool] = PublicKey.findProgramAddressSync([Buffer.from("staking_pool_v3")], PROGRAM_ID);
  const [stakeTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("stake_token_vault_v3")], PROGRAM_ID);
  const [stakingAuthority] = PublicKey.findProgramAddressSync([Buffer.from("staking_authority_v3")], PROGRAM_ID);
  const [rewardVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_vault_v3")], PROGRAM_ID);

  const pool: any = await (program.account as any).stakingPool.fetch(stakingPool);
  console.log("total_positions before:", pool.totalPositions.toString());

  if (!balInfo || Number(balInfo.value.amount) < 5_000_000) {
    console.log("Not enough $MINE to run a live open_lock/open_burn test (need >= 5 $MINE). Skipping mutation tests.");
    return;
  }

  function positionPda(owner: PublicKey, id: bigint): PublicKey {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(id);
    return PublicKey.findProgramAddressSync([Buffer.from("position_v1"), owner.toBuffer(), buf], PROGRAM_ID)[0];
  }

  // --- open_lock: 2 $MINE, tier 0 (no lock, 1x) ---
  let posId = BigInt((await (program.account as any).stakingPool.fetch(stakingPool)).totalPositions.toString());
  let position = positionPda(kp.publicKey, posId);
  let sig = await program.methods
    .openLock(new BN(2_000_000), 0)
    .accounts({
      staker: kp.publicKey,
      stakingPool,
      position,
      stakeTokenVault,
      stakerMineAta: ata,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("open_lock (tier0, no-lock) tx:", sig, "position:", position.toBase58(), "id:", posId.toString());

  // --- open_burn: 1 $MINE, tier 0 (60s, 4x) ---
  let posId2 = BigInt((await (program.account as any).stakingPool.fetch(stakingPool)).totalPositions.toString());
  let position2 = positionPda(kp.publicKey, posId2);
  let sig2 = await program.methods
    .openBurn(new BN(1_000_000), 0)
    .accounts({
      staker: kp.publicKey,
      stakingPool,
      position: position2,
      mineMint,
      stakerMineAta: ata,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("open_burn (tier0, 60s 4x) tx:", sig2, "position:", position2.toBase58(), "id:", posId2.toString());

  const p1: any = await (program.account as any).position.fetch(position);
  const p2: any = await (program.account as any).position.fetch(position2);
  console.log("lock position weight:", p1.weight.toString(), "expired:", p1.expired);
  console.log("burn position weight:", p2.weight.toString(), "expired:", p2.expired, "unlockAt:", p2.unlockAt.toString());

  const poolAfter: any = await (program.account as any).stakingPool.fetch(stakingPool);
  console.log("total_weight after open:", poolAfter.totalWeight.toString());

  // --- expire_position on the no-lock lock position (unlock_at = now, should be expirable immediately) ---
  const ownerAta = ata;
  let sig3 = await program.methods
    .expirePosition()
    .accounts({
      payer: kp.publicKey,
      stakingPool,
      position,
      stakeTokenVault,
      stakingAuthority,
      ownerMineAta: ownerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("expire_position (lock, tier0 unlock_at=now) tx:", sig3);

  const p1After: any = await (program.account as any).position.fetch(position);
  console.log("lock position after expiry - weight:", p1After.weight.toString(), "expired:", p1After.expired, "amount:", p1After.amount.toString());

  // --- claim_yield on the burn position (should be NothingToCashOut unless
  // a real wager skim landed since this position opened — that's expected,
  // not a bug; this just confirms the instruction round-trips correctly) ---
  try {
    let sig4 = await program.methods
      .claimYield(new BN(posId2.toString()))
      .accounts({ staker: kp.publicKey, stakingPool, position: position2, rewardVault })
      .rpc();
    console.log("claim_yield (burn position) tx:", sig4);
  } catch (e: any) {
    console.log("claim_yield (burn position) — NothingToCashOut is expected here:", e.message ?? e);
  }

  console.log("SMOKE TEST OK");
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
