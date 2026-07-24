/**
 * Manual end-to-end verification script for the label-vault program — not
 * part of the app. Creates a fresh label (60/40 split across the two mock
 * testnet pools), deposits, checks the resulting split, then withdraws half.
 * Run with: npx tsx scratch-test-label-vault.ts (from web/, needs
 * ~/x1-lst/keys/deployer-testnet.json funded on X1 testnet).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
  MINT_SIZE,
} from "@solana/spl-token";
import * as fs from "fs";
import { getStakePoolAccount } from "./lib/stake-pool";
import { findWithdrawAuthorityProgramAddress } from "./lib/stake-pool/utils/program-address";

const RPC = "https://rpc.testnet.x1.xyz";
const LABEL_VAULT_PROGRAM = new PublicKey("HuxK4tFifoCfUzN1asHf5xae7XqszmkEC9gMvxPSVekG");
const POOL1 = new PublicKey("9Ct35Dtu7Pnk2LXsKSeLyGupnvZpfxVDvvQ8X8biz6Ne"); // mock "rXNT"
const POOL2 = new PublicKey("9SA2Xsqn5BbihiswScziKaGWmjr6KAByqb1emEsnC1fW"); // mock "pXNT"
const STAKE_POOL_PROGRAM = new PublicKey("HjJ81j6LvguqZP17WwPrWihqpCqWYMqPdVCEDtDXDd23");

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function packFixedStr(s: string, n: number): Buffer {
  const buf = Buffer.alloc(n);
  buf.write(s, 0, Math.min(s.length, n), "utf-8");
  return buf;
}

// Borsh-ish manual encoding matching label-vault's VaultInstruction enum.
function encodeCreateLabel(name: string, symbol: string, weights: number[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0])]; // variant 0 = CreateLabel
  parts.push(packFixedStr(name, 32));
  parts.push(packFixedStr(symbol, 10));
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(weights.length, 0);
  parts.push(lenBuf);
  for (const w of weights) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(w, 0);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

function encodeDeposit(lamportsIn: bigint): Buffer {
  const buf = Buffer.alloc(9);
  buf.writeUInt8(1, 0); // variant 1 = Deposit
  buf.writeBigUInt64LE(lamportsIn, 1);
  return buf;
}

function encodeWithdraw(labelTokensIn: bigint): Buffer {
  const buf = Buffer.alloc(9);
  buf.writeUInt8(2, 0); // variant 2 = Withdraw
  buf.writeBigUInt64LE(labelTokensIn, 1);
  return buf;
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const payer = loadKeypair(process.env.HOME + "/x1-lst/keys/deployer-testnet.json");
  console.log("payer:", payer.publicKey.toBase58());

  const labelMint = Keypair.generate();
  console.log("label mint:", labelMint.publicKey.toBase58());

  const [vaultConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_config"), labelMint.publicKey.toBuffer()],
    LABEL_VAULT_PROGRAM,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority"), labelMint.publicKey.toBuffer()],
    LABEL_VAULT_PROGRAM,
  );
  console.log("vault config:", vaultConfig.toBase58());
  console.log("vault authority:", vaultAuthority.toBase58());

  async function withRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw lastErr;
  }

  const pool1Info = await withRetry(() => getStakePoolAccount(connection, POOL1));
  const pool2Info = await withRetry(() => getStakePoolAccount(connection, POOL2));
  const pool1Mint = pool1Info.account.data.poolMint;
  const pool2Mint = pool2Info.account.data.poolMint;
  const pool1WithdrawAuth = await findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM, POOL1);
  const pool2WithdrawAuth = await findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM, POOL2);

  const vaultAta1 = getAssociatedTokenAddressSync(pool1Mint, vaultAuthority, true);
  const vaultAta2 = getAssociatedTokenAddressSync(pool2Mint, vaultAuthority, true);
  console.log("vault ATA for pool1 LST:", vaultAta1.toBase58());
  console.log("vault ATA for pool2 LST:", vaultAta2.toBase58());

  // --- TX 1: create label mint + vault ATAs ---
  const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const tx1 = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: labelMint.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(labelMint.publicKey, 9, vaultAuthority, null),
    createAssociatedTokenAccountInstruction(payer.publicKey, vaultAta1, vaultAuthority, pool1Mint),
    createAssociatedTokenAccountInstruction(payer.publicKey, vaultAta2, vaultAuthority, pool2Mint),
  );
  const sig1 = await sendAndConfirmTransaction(connection, tx1, [payer, labelMint], {
    commitment: "confirmed",
  });
  console.log("TX1 (setup) signature:", sig1);

  // --- TX 2: CreateLabel ---
  const createLabelIx = new TransactionInstruction({
    programId: LABEL_VAULT_PROGRAM,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: vaultConfig, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: labelMint.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: POOL1, isSigner: false, isWritable: false },
      { pubkey: vaultAta1, isSigner: false, isWritable: false },
      { pubkey: POOL2, isSigner: false, isWritable: false },
      { pubkey: vaultAta2, isSigner: false, isWritable: false },
    ],
    data: encodeCreateLabel("Test Basket XNT", "tXNT", [6000, 4000]),
  });
  const tx2 = new Transaction().add(createLabelIx);
  const sig2 = await sendAndConfirmTransaction(connection, tx2, [payer], { commitment: "confirmed" });
  console.log("TX2 (create label) signature:", sig2);

  // --- TX 3: Deposit ---
  const depositorLabelAta = getAssociatedTokenAddressSync(labelMint.publicKey, payer.publicKey);
  const depositAmount = 3_000_000_000n; // 3 XNT

  const allocAccounts = (pool: PublicKey, withdrawAuth: PublicKey, reserve: PublicKey, vaultAta: PublicKey, feeAcc: PublicKey, mint: PublicKey) => [
    { pubkey: STAKE_POOL_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: withdrawAuth, isSigner: false, isWritable: false },
    { pubkey: reserve, isSigner: false, isWritable: true },
    { pubkey: vaultAta, isSigner: false, isWritable: true },
    { pubkey: feeAcc, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: true },
  ];

  const depositIx = new TransactionInstruction({
    programId: LABEL_VAULT_PROGRAM,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: vaultConfig, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: true },
      { pubkey: labelMint.publicKey, isSigner: false, isWritable: true },
      { pubkey: depositorLabelAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...allocAccounts(
        POOL1,
        pool1WithdrawAuth,
        pool1Info.account.data.reserveStake,
        vaultAta1,
        pool1Info.account.data.managerFeeAccount,
        pool1Mint,
      ),
      ...allocAccounts(
        POOL2,
        pool2WithdrawAuth,
        pool2Info.account.data.reserveStake,
        vaultAta2,
        pool2Info.account.data.managerFeeAccount,
        pool2Mint,
      ),
    ],
    data: encodeDeposit(depositAmount),
  });

  const tx3 = new Transaction().add(
    createAssociatedTokenAccountInstruction(payer.publicKey, depositorLabelAta, payer.publicKey, labelMint.publicKey),
    depositIx,
  );
  const sig3 = await sendAndConfirmTransaction(connection, tx3, [payer], { commitment: "confirmed" });
  console.log("TX3 (deposit) signature:", sig3);

  const labelBalanceAfterDeposit = await getAccount(connection, depositorLabelAta);
  const vaultAta1After = await getAccount(connection, vaultAta1);
  const vaultAta2After = await getAccount(connection, vaultAta2);
  console.log("label tokens minted:", labelBalanceAfterDeposit.amount.toString());
  console.log("vault ATA1 (pool1 LST) balance:", vaultAta1After.amount.toString());
  console.log("vault ATA2 (pool2 LST) balance:", vaultAta2After.amount.toString());

  // --- TX 4: Withdraw half ---
  const withdrawAmount = labelBalanceAfterDeposit.amount / 2n;
  const withdrawIx = new TransactionInstruction({
    programId: LABEL_VAULT_PROGRAM,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: vaultConfig, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: labelMint.publicKey, isSigner: false, isWritable: true },
      { pubkey: depositorLabelAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("SysvarC1ock11111111111111111111111111111111"), isSigner: false, isWritable: false },
      { pubkey: new PublicKey("SysvarStakeHistory1111111111111111111111111"), isSigner: false, isWritable: false },
      { pubkey: new PublicKey("Stake11111111111111111111111111111111111111"), isSigner: false, isWritable: false },
      ...allocAccounts(
        POOL1,
        pool1WithdrawAuth,
        pool1Info.account.data.reserveStake,
        vaultAta1,
        pool1Info.account.data.managerFeeAccount,
        pool1Mint,
      ),
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
      ...allocAccounts(
        POOL2,
        pool2WithdrawAuth,
        pool2Info.account.data.reserveStake,
        vaultAta2,
        pool2Info.account.data.managerFeeAccount,
        pool2Mint,
      ),
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
    ],
    data: encodeWithdraw(withdrawAmount),
  });

  const balBefore = await connection.getBalance(payer.publicKey, "confirmed");
  const tx4 = new Transaction().add(withdrawIx);
  const sig4 = await sendAndConfirmTransaction(connection, tx4, [payer], { commitment: "confirmed" });
  console.log("TX4 (withdraw) signature:", sig4);
  const balAfter = await connection.getBalance(payer.publicKey, "confirmed");
  console.log("wallet balance delta from withdraw (lamports):", balAfter - balBefore);

  const labelBalanceAfterWithdraw = await getAccount(connection, depositorLabelAta);
  console.log("label tokens remaining:", labelBalanceAfterWithdraw.amount.toString());

  console.log("\n=== SUCCESS ===");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
