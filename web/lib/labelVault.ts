import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
  MINT_SIZE,
} from "@solana/spl-token";
import { getStakePoolAccount } from "@/lib/stake-pool";
import { findWithdrawAuthorityProgramAddress } from "@/lib/stake-pool/utils/program-address";

// X1 testnet's public RPC is a proxy in front of multiple backend nodes with
// inconsistent health, and rate-limits (HTTP 429) under any real load — every
// read used to actually build a transaction (not just to display data) needs
// to survive a transient failure, not just the passive page-refresh reads.
async function withRetry<T>(fn: () => Promise<T>, attempts = 6, delayMs = 1200): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * Client for the label-vault program — a "Label" is a user-created basket
 * vault that splits deposits across several underlying stake-pool-family
 * LSTs by weight and mints one share token for the blended position (the
 * ClearSol mechanism). See label-vault/program in the repo for the on-chain
 * side; this hand-encodes instructions since the program has no existing SDK.
 */

export const LABEL_VAULT_PROGRAM_ID = new PublicKey(
  "HuxK4tFifoCfUzN1asHf5xae7XqszmkEC9gMvxPSVekG",
);

export const MAX_ALLOCATIONS = 2;
export const MAX_NAME_LEN = 32;
export const MAX_SYMBOL_LEN = 10;
const ALLOCATION_LEN = 32 * 7 + 2;
export const VAULT_CONFIG_LEN = 1 + 32 + 32 + 1 + 1 + MAX_NAME_LEN + MAX_SYMBOL_LEN + MAX_ALLOCATIONS * ALLOCATION_LEN;

export interface Allocation {
  poolProgramId: PublicKey;
  poolAddress: PublicKey;
  poolWithdrawAuthority: PublicKey;
  reserveStake: PublicKey;
  poolMint: PublicKey;
  managerFeeAccount: PublicKey;
  vaultTokenAccount: PublicKey;
  weightBps: number;
}

export interface VaultConfig {
  isInitialized: boolean;
  creator: PublicKey;
  labelMint: PublicKey;
  vaultAuthorityBump: number;
  allocationCount: number;
  name: string;
  symbol: string;
  allocations: Allocation[];
}

export function findVaultConfigAddress(labelMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_config"), labelMint.toBuffer()],
    LABEL_VAULT_PROGRAM_ID,
  );
}

export function findVaultAuthorityAddress(labelMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority"), labelMint.toBuffer()],
    LABEL_VAULT_PROGRAM_ID,
  );
}

function packFixedStr(s: string, n: number): Buffer {
  const buf = Buffer.alloc(n);
  buf.write(s, 0, Math.min(Buffer.byteLength(s), n), "utf-8");
  return buf;
}

function unpackFixedStr(buf: Buffer): string {
  const nul = buf.indexOf(0);
  return buf.subarray(0, nul === -1 ? buf.length : nul).toString("utf-8");
}

function encodeCreateLabel(name: string, symbol: string, weightsBps: number[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0])]; // variant 0 = CreateLabel
  parts.push(packFixedStr(name, MAX_NAME_LEN));
  parts.push(packFixedStr(symbol, MAX_SYMBOL_LEN));
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(weightsBps.length, 0);
  parts.push(lenBuf);
  for (const w of weightsBps) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(w, 0);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

// Buffer.prototype.writeBigUInt64LE isn't implemented by every browser build
// of the `buffer` polyfill — DataView.setBigUint64 is standard Web API and
// works regardless, so instruction encoding uses it instead of Buffer's
// Node-style write methods.
function u64LEBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  new DataView(buf.buffer, buf.byteOffset, 8).setBigUint64(0, value, true);
  return buf;
}

function encodeDeposit(lamportsIn: bigint): Buffer {
  return Buffer.concat([Buffer.from([1]), u64LEBytes(lamportsIn)]); // variant 1 = Deposit
}

function encodeWithdraw(labelTokensIn: bigint): Buffer {
  return Buffer.concat([Buffer.from([2]), u64LEBytes(labelTokensIn)]); // variant 2 = Withdraw
}

function encodeRebalance(): Buffer {
  return Buffer.from([3]); // variant 3 = Rebalance, no extra data
}

/** Decodes a raw VaultConfig account buffer (see label-vault/program/src/state.rs). */
export function decodeVaultConfig(data: Buffer): VaultConfig {
  let o = 0;
  const isInitialized = data.readUInt8(o) === 1;
  o += 1;
  const creator = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const labelMint = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const vaultAuthorityBump = data.readUInt8(o);
  o += 1;
  const allocationCount = data.readUInt8(o);
  o += 1;
  const name = unpackFixedStr(data.subarray(o, o + MAX_NAME_LEN));
  o += MAX_NAME_LEN;
  const symbol = unpackFixedStr(data.subarray(o, o + MAX_SYMBOL_LEN));
  o += MAX_SYMBOL_LEN;

  const allocations: Allocation[] = [];
  for (let i = 0; i < MAX_ALLOCATIONS; i++) {
    const base = o + i * ALLOCATION_LEN;
    let p = base;
    const poolProgramId = new PublicKey(data.subarray(p, p + 32));
    p += 32;
    const poolAddress = new PublicKey(data.subarray(p, p + 32));
    p += 32;
    const poolWithdrawAuthority = new PublicKey(data.subarray(p, p + 32));
    p += 32;
    const reserveStake = new PublicKey(data.subarray(p, p + 32));
    p += 32;
    const poolMint = new PublicKey(data.subarray(p, p + 32));
    p += 32;
    const managerFeeAccount = new PublicKey(data.subarray(p, p + 32));
    p += 32;
    const vaultTokenAccount = new PublicKey(data.subarray(p, p + 32));
    p += 32;
    const weightBps = data.readUInt16LE(p);
    if (i < allocationCount) {
      allocations.push({
        poolProgramId,
        poolAddress,
        poolWithdrawAuthority,
        reserveStake,
        poolMint,
        managerFeeAccount,
        vaultTokenAccount,
        weightBps,
      });
    }
  }

  return {
    isInitialized,
    creator,
    labelMint,
    vaultAuthorityBump,
    allocationCount,
    name,
    symbol,
    allocations,
  };
}

export async function getVaultConfig(
  connection: Connection,
  vaultConfigAddress: PublicKey,
): Promise<VaultConfig | null> {
  const info = await withRetry(() => connection.getAccountInfo(vaultConfigAddress, "confirmed"));
  if (!info) return null;
  return decodeVaultConfig(info.data);
}

/** Lists all Labels created under the label-vault program (filters by exact account size). */
export async function listLabels(
  connection: Connection,
): Promise<{ address: PublicKey; config: VaultConfig }[]> {
  const accounts = await withRetry(() =>
    connection.getProgramAccounts(LABEL_VAULT_PROGRAM_ID, {
      filters: [{ dataSize: VAULT_CONFIG_LEN }],
      commitment: "confirmed",
    }),
  );
  return accounts.map(({ pubkey, account }) => ({
    address: pubkey,
    config: decodeVaultConfig(account.data),
  }));
}

export interface AllocationTarget {
  poolAddress: PublicKey;
  weightBps: number;
}

/**
 * Builds the two transactions needed to create a Label: (1) create + init
 * the label mint and the vault's ATAs for each underlying pool's LST, and
 * (2) the CreateLabel instruction itself. Split because the setup step needs
 * the label mint's own signature, and because it must land before
 * CreateLabel can reference the (by-then-existing) ATAs.
 */
export async function buildCreateLabelTransactions(
  connection: Connection,
  payer: PublicKey,
  name: string,
  symbol: string,
  allocationTargets: AllocationTarget[],
): Promise<{
  setupInstructions: TransactionInstruction[];
  createLabelInstructions: TransactionInstruction[];
  signers: Keypair[];
  labelMint: PublicKey;
  vaultConfig: PublicKey;
  vaultAuthority: PublicKey;
}> {
  if (allocationTargets.length === 0 || allocationTargets.length > MAX_ALLOCATIONS) {
    throw new Error(`Need between 1 and ${MAX_ALLOCATIONS} allocations`);
  }
  const weightSum = allocationTargets.reduce((s, a) => s + a.weightBps, 0);
  if (weightSum !== 10_000) {
    throw new Error(`Allocation weights must sum to 100% (got ${weightSum / 100}%)`);
  }

  const labelMint = Keypair.generate();
  const [vaultConfig] = findVaultConfigAddress(labelMint.publicKey);
  const [vaultAuthority] = findVaultAuthorityAddress(labelMint.publicKey);

  const pools = await Promise.all(
    allocationTargets.map((t) => withRetry(() => getStakePoolAccount(connection, t.poolAddress))),
  );

  const mintRent = await withRetry(() => connection.getMinimumBalanceForRentExemption(MINT_SIZE));
  const setupInstructions: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: labelMint.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(labelMint.publicKey, 9, vaultAuthority, null),
  ];

  const createLabelKeys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: vaultConfig, isSigner: false, isWritable: true },
    { pubkey: vaultAuthority, isSigner: false, isWritable: false },
    { pubkey: labelMint.publicKey, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  for (const pool of pools) {
    const poolMint = pool.account.data.poolMint;
    const vaultAta = getAssociatedTokenAddressSync(poolMint, vaultAuthority, true);
    setupInstructions.push(
      createAssociatedTokenAccountInstruction(payer, vaultAta, vaultAuthority, poolMint),
    );
    createLabelKeys.push(
      { pubkey: pool.pubkey, isSigner: false, isWritable: false },
      { pubkey: vaultAta, isSigner: false, isWritable: false },
    );
  }

  const createLabelInstructions: TransactionInstruction[] = [
    new TransactionInstruction({
      programId: LABEL_VAULT_PROGRAM_ID,
      keys: createLabelKeys,
      data: encodeCreateLabel(
        name,
        symbol,
        allocationTargets.map((t) => t.weightBps),
      ),
    }),
  ];

  return {
    setupInstructions,
    createLabelInstructions,
    signers: [labelMint],
    labelMint: labelMint.publicKey,
    vaultConfig,
    vaultAuthority,
  };
}

export async function buildDepositTransaction(
  connection: Connection,
  depositor: PublicKey,
  vaultConfigAddress: PublicKey,
  lamportsIn: bigint,
): Promise<{ instructions: TransactionInstruction[] }> {
  const vaultConfig = await getVaultConfig(connection, vaultConfigAddress);
  if (!vaultConfig) throw new Error("Label not found");
  const [vaultAuthority] = findVaultAuthorityAddress(vaultConfig.labelMint);

  const depositorLabelAta = getAssociatedTokenAddressSync(vaultConfig.labelMint, depositor);
  const instructions: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      depositor,
      depositorLabelAta,
      depositor,
      vaultConfig.labelMint,
    ),
  ];

  const keys = [
    { pubkey: depositor, isSigner: true, isWritable: true },
    { pubkey: vaultConfigAddress, isSigner: false, isWritable: true },
    { pubkey: vaultAuthority, isSigner: false, isWritable: true },
    { pubkey: vaultConfig.labelMint, isSigner: false, isWritable: true },
    { pubkey: depositorLabelAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  for (const a of vaultConfig.allocations) {
    keys.push(
      { pubkey: a.poolProgramId, isSigner: false, isWritable: false },
      { pubkey: a.poolAddress, isSigner: false, isWritable: true },
      { pubkey: a.poolWithdrawAuthority, isSigner: false, isWritable: false },
      { pubkey: a.reserveStake, isSigner: false, isWritable: true },
      { pubkey: a.vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: a.managerFeeAccount, isSigner: false, isWritable: true },
      { pubkey: a.poolMint, isSigner: false, isWritable: true },
    );
  }

  instructions.push(
    new TransactionInstruction({
      programId: LABEL_VAULT_PROGRAM_ID,
      keys,
      data: encodeDeposit(lamportsIn),
    }),
  );

  return { instructions };
}

export async function buildWithdrawTransaction(
  connection: Connection,
  withdrawer: PublicKey,
  vaultConfigAddress: PublicKey,
  labelTokensIn: bigint,
): Promise<{ instructions: TransactionInstruction[] }> {
  const vaultConfig = await getVaultConfig(connection, vaultConfigAddress);
  if (!vaultConfig) throw new Error("Label not found");
  const [vaultAuthority] = findVaultAuthorityAddress(vaultConfig.labelMint);
  const withdrawerLabelAta = getAssociatedTokenAddressSync(vaultConfig.labelMint, withdrawer);

  const keys = [
    { pubkey: withdrawer, isSigner: true, isWritable: false },
    { pubkey: vaultConfigAddress, isSigner: false, isWritable: true },
    { pubkey: vaultAuthority, isSigner: false, isWritable: false },
    { pubkey: vaultConfig.labelMint, isSigner: false, isWritable: true },
    { pubkey: withdrawerLabelAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: new PublicKey("SysvarC1ock11111111111111111111111111111111"), isSigner: false, isWritable: false },
    { pubkey: new PublicKey("SysvarStakeHistory1111111111111111111111111"), isSigner: false, isWritable: false },
    { pubkey: new PublicKey("Stake11111111111111111111111111111111111111"), isSigner: false, isWritable: false },
  ];
  for (const a of vaultConfig.allocations) {
    keys.push(
      { pubkey: a.poolProgramId, isSigner: false, isWritable: false },
      { pubkey: a.poolAddress, isSigner: false, isWritable: true },
      { pubkey: a.poolWithdrawAuthority, isSigner: false, isWritable: false },
      { pubkey: a.reserveStake, isSigner: false, isWritable: true },
      { pubkey: a.vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: a.managerFeeAccount, isSigner: false, isWritable: true },
      { pubkey: a.poolMint, isSigner: false, isWritable: true },
      { pubkey: withdrawer, isSigner: false, isWritable: true },
    );
  }

  return {
    instructions: [
      new TransactionInstruction({
        programId: LABEL_VAULT_PROGRAM_ID,
        keys,
        data: encodeWithdraw(labelTokensIn),
      }),
    ],
  };
}

/**
 * Operator-only. Reads each allocation's last-epoch yield and actively moves
 * capital toward the best performer (capped, see
 * label-vault/program/src/state.rs::REBALANCE_WINNER_WEIGHT_BPS). Only the
 * Label's creator can build a Rebalance that will actually be accepted —
 * this is deliberately not exposed as a public "rebalance" button; run it
 * from an operator script/cron instead.
 */
export async function buildRebalanceTransaction(
  connection: Connection,
  creator: PublicKey,
  vaultConfigAddress: PublicKey,
): Promise<{ instructions: TransactionInstruction[] }> {
  const vaultConfig = await getVaultConfig(connection, vaultConfigAddress);
  if (!vaultConfig) throw new Error("Label not found");
  const [vaultAuthority] = findVaultAuthorityAddress(vaultConfig.labelMint);

  const keys = [
    { pubkey: creator, isSigner: true, isWritable: false },
    { pubkey: vaultConfigAddress, isSigner: false, isWritable: true },
    { pubkey: vaultAuthority, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: new PublicKey("SysvarC1ock11111111111111111111111111111111"), isSigner: false, isWritable: false },
    { pubkey: new PublicKey("SysvarStakeHistory1111111111111111111111111"), isSigner: false, isWritable: false },
    { pubkey: new PublicKey("Stake11111111111111111111111111111111111111"), isSigner: false, isWritable: false },
  ];
  for (const a of vaultConfig.allocations) {
    keys.push(
      { pubkey: a.poolProgramId, isSigner: false, isWritable: false },
      { pubkey: a.poolAddress, isSigner: false, isWritable: true },
      { pubkey: a.poolWithdrawAuthority, isSigner: false, isWritable: false },
      { pubkey: a.reserveStake, isSigner: false, isWritable: true },
      { pubkey: a.vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: a.managerFeeAccount, isSigner: false, isWritable: true },
      { pubkey: a.poolMint, isSigner: false, isWritable: true },
    );
  }

  return {
    instructions: [
      new TransactionInstruction({
        programId: LABEL_VAULT_PROGRAM_ID,
        keys,
        data: encodeRebalance(),
      }),
    ],
  };
}

/** Sums each allocation's value (in lamports of the base asset) at the underlying pool's current exchange rate. */
export async function computeLabelNav(
  connection: Connection,
  vaultConfig: VaultConfig,
): Promise<{ navLamports: bigint; perAllocation: { poolAddress: PublicKey; valueLamports: bigint; balance: bigint }[] }> {
  let navLamports = 0n;
  const perAllocation: { poolAddress: PublicKey; valueLamports: bigint; balance: bigint }[] = [];
  for (const a of vaultConfig.allocations) {
    const [pool, tokenAccount] = await Promise.all([
      withRetry(() => getStakePoolAccount(connection, a.poolAddress)),
      withRetry(() => getAccount(connection, a.vaultTokenAccount)),
    ]);
    const totalLamports = BigInt(pool.account.data.totalLamports.toString());
    const poolTokenSupply = BigInt(pool.account.data.poolTokenSupply.toString()) || 1n;
    const balance = tokenAccount.amount;
    const value = (balance * totalLamports) / poolTokenSupply;
    navLamports += value;
    perAllocation.push({ poolAddress: a.poolAddress, valueLamports: value, balance });
  }
  return { navLamports, perAllocation };
}

export async function getLabelMintSupply(connection: Connection, labelMint: PublicKey): Promise<bigint> {
  const mint = await withRetry(() => getMint(connection, labelMint));
  return mint.supply;
}

export { findWithdrawAuthorityProgramAddress };
