/**
 * One-time admin setup for the $MINE/XNT liquidity pool. Seeds an initial
 * arbitrary price (there's no organic price discovery yet) — tune the
 * ratio once real trading activity gives a better signal.
 */
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import fs from "node:fs";
import { PROGRAM_ID, RPC_URL, configPda } from "./config.js";
import { minesIdl } from "./idl.js";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const ADMIN_KEYPAIR_PATH = process.env.ADMIN_KEYPAIR_PATH ?? "../keys/deployer-testnet.json";
const INITIAL_XNT = Number(process.env.INITIAL_XNT ?? 0.4);
const INITIAL_MINE = Number(process.env.INITIAL_MINE ?? 40);

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const adminKeypair = loadKeypair(ADMIN_KEYPAIR_PATH);
  const wallet = new Wallet(adminKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(minesIdl, PROGRAM_ID, provider);

  const [config] = configPda();
  const configAccount: any = await (program.account as any).config.fetch(config);

  const [pool] = PublicKey.findProgramAddressSync([Buffer.from("liquidity_pool")], PROGRAM_ID);
  const [poolAuthority] = PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], PROGRAM_ID);
  const [poolXntVault] = PublicKey.findProgramAddressSync([Buffer.from("pool_xnt_vault")], PROGRAM_ID);
  const [poolMineVault] = PublicKey.findProgramAddressSync([Buffer.from("pool_mine_vault")], PROGRAM_ID);
  const adminMineAta = getAssociatedTokenAddressSync(configAccount.mineMint, adminKeypair.publicKey);

  const sig = await program.methods
    .initializeLiquidityPool(new BN(Math.round(INITIAL_XNT * 1e9)), new BN(Math.round(INITIAL_MINE * 1e6)))
    .accounts({
      admin: adminKeypair.publicKey,
      config,
      pool,
      poolAuthority,
      poolXntVault,
      mineMint: configAccount.mineMint,
      poolMineVault,
      adminMineAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`liquidity pool initialized (tx ${sig})`);
  console.log(`pool: ${pool.toBase58()}`);
  console.log(`initial price: ${(INITIAL_XNT / INITIAL_MINE).toFixed(6)} XNT per $MINE`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
