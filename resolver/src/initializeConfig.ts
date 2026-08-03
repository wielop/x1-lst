/**
 * One-time admin setup: creates the Config PDA, the $MINE mint, and the two
 * reward-pool token accounts. Run once, right after the program is deployed.
 *
 * Split into three separate on-chain instructions (config -> mint -> pools)
 * because validating all of those accounts in a single instruction overflows
 * the BPF 4KB stack frame at runtime — see the comment on initialize_config
 * in programs/mines/src/lib.rs.
 */
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import fs from "node:fs";
import { PROGRAM_ID, RPC_URL, configPda } from "./config.js";
import { minesIdl } from "./idl.js";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const ADMIN_KEYPAIR_PATH = process.env.ADMIN_KEYPAIR_PATH ?? "../keys/deployer-testnet.json";
const RESOLVER_PUBKEY = process.env.RESOLVER_PUBKEY;
const TREASURY_PUBKEY = process.env.TREASURY_PUBKEY;
const HOUSE_EDGE_BPS = Number(process.env.HOUSE_EDGE_BPS ?? 200); // 2%
const MIN_BET_XNT = Number(process.env.MIN_BET_XNT ?? 0.01);
const MAX_BET_XNT = Number(process.env.MAX_BET_XNT ?? 10);

async function main() {
  if (!RESOLVER_PUBKEY || !TREASURY_PUBKEY) {
    throw new Error("set RESOLVER_PUBKEY and TREASURY_PUBKEY env vars before running");
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const adminKeypair = loadKeypair(ADMIN_KEYPAIR_PATH);
  const wallet = new Wallet(adminKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(minesIdl, PROGRAM_ID, provider);

  const [config] = configPda();
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID);
  const [mintAuthority] = PublicKey.findProgramAddressSync([Buffer.from("mint_authority")], PROGRAM_ID);
  const [mineMint] = PublicKey.findProgramAddressSync([Buffer.from("mine_mint")], PROGRAM_ID);

  const leaderboardPool = Keypair.generate();
  const rakebackPool = Keypair.generate();

  const minBetLamports = Math.round(MIN_BET_XNT * 1_000_000_000);
  const maxBetLamports = Math.round(MAX_BET_XNT * 1_000_000_000);

  const sig1 = await program.methods
    .initializeConfig(
      new PublicKey(RESOLVER_PUBKEY),
      new PublicKey(TREASURY_PUBKEY),
      HOUSE_EDGE_BPS,
      new BN(minBetLamports),
      new BN(maxBetLamports),
    )
    .accounts({
      admin: adminKeypair.publicKey,
      config,
      vault,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`1/3 config created (tx ${sig1})`);

  const sig2 = await program.methods
    .initializeMint()
    .accounts({
      admin: adminKeypair.publicKey,
      config,
      mintAuthority,
      mineMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`2/3 $MINE mint created (tx ${sig2})`);

  const sig3 = await program.methods
    .initializePools()
    .accounts({
      admin: adminKeypair.publicKey,
      config,
      mineMint,
      leaderboardPool: leaderboardPool.publicKey,
      rakebackPool: rakebackPool.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([leaderboardPool, rakebackPool])
    .rpc();
  console.log(`3/3 reward pools created (tx ${sig3})`);

  console.log(`config: ${config.toBase58()}`);
  console.log(`vault: ${vault.toBase58()}`);
  console.log(`mine mint: ${mineMint.toBase58()}`);
  console.log(`leaderboard pool: ${leaderboardPool.publicKey.toBase58()}`);
  console.log(`rakeback pool: ${rakebackPool.publicKey.toBase58()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
