/**
 * Operator script: retires the current server seed and commits a fresh one.
 * Run manually (npx tsx src/rotateSeed.ts) or on a cron — mirrors the
 * standalone-script convention used by GigaSwap's scripts/*.ts.
 *
 * Run `revealSeed.ts` for the *previous* seed only once you're sure no round
 * still open references it (safest: wait until no Active rounds reference
 * that commitment hash before revealing).
 */
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "node:fs";
import { PROGRAM_ID, RPC_URL, RESOLVER_KEYPAIR_PATH, SEED_STORE_PATH, configPda } from "./config.js";
import { rotateSeed } from "./seedStore.js";
import { minesIdl } from "./idl.js";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const resolverKeypair = loadKeypair(RESOLVER_KEYPAIR_PATH);
  const wallet = new Wallet(resolverKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(minesIdl, PROGRAM_ID, provider);

  const [config] = configPda();
  const store = rotateSeed(SEED_STORE_PATH);

  const sig = await program.methods
    .commitSeed(Array.from(Buffer.from(store.current.hash, "hex")))
    .accounts({ resolverAuthority: resolverKeypair.publicKey, config })
    .rpc();

  console.log(`rotated seed. new commitment ${store.current.hash} (tx ${sig})`);
  console.log(`${store.retired.length} retired seed(s) awaiting reveal via revealSeed.ts`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
