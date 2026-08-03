/**
 * Operator script: publishes the raw seed behind a retired (already
 * rotated-away-from) commitment, so anyone can recompute every round
 * settled under it and confirm the resolver never lied.
 *
 * Only run this for a retired seed once you're confident no round is still
 * Active under its commitment — revealing early would let a sharp player
 * compute mine layouts for any round still open under that seed.
 */
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "node:fs";
import { PROGRAM_ID, RPC_URL, RESOLVER_KEYPAIR_PATH, SEED_STORE_PATH } from "./config.js";
import { loadStore, saveStore } from "./seedStore.js";
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

  const store = loadStore(SEED_STORE_PATH);
  const next = store.retired.find((s) => !s.revealed);
  if (!next) {
    console.log("no un-revealed retired seeds");
    return;
  }

  const sig = await program.methods
    .revealSeed(
      Array.from(Buffer.from(next.raw, "hex")),
      Array.from(Buffer.from(next.hash, "hex")),
    )
    .accounts({ resolverAuthority: resolverKeypair.publicKey })
    .rpc();

  next.revealed = true;
  saveStore(SEED_STORE_PATH, store);
  console.log(`revealed seed for commitment ${next.hash} (tx ${sig})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
