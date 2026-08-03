import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "node:fs";
import { PROGRAM_ID, RPC_URL, RESOLVER_KEYPAIR_PATH, SEED_STORE_PATH, configPda } from "./config.js";
import { loadStore } from "./seedStore.js";
import { minesIdl } from "./idl.js";
import { startHttpServer } from "./http.js";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function bytesToHex(bytes: number[] | Buffer): string {
  return Buffer.from(bytes).toString("hex");
}

async function ensureSeedCommitted() {
  const connection = new Connection(RPC_URL, "confirmed");
  const resolverKeypair = loadKeypair(RESOLVER_KEYPAIR_PATH);
  const wallet = new Wallet(resolverKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(minesIdl, PROGRAM_ID, provider);

  const [config] = configPda();
  const store = loadStore(SEED_STORE_PATH);

  const configAccount = await (program.account as any).config.fetch(config);
  const onChainHash = bytesToHex(configAccount.currentSeedHash);
  if (onChainHash === "00".repeat(32)) {
    await program.methods
      .commitSeed(Array.from(Buffer.from(store.current.hash, "hex")))
      .accounts({ resolverAuthority: resolverKeypair.publicKey, config })
      .rpc();
    console.log(`[resolver] committed initial seed hash ${store.current.hash}`);
  } else if (onChainHash !== store.current.hash) {
    console.warn(
      `[resolver] local seed store (${store.current.hash}) does not match on-chain commitment (${onChainHash}). ` +
        `Not auto-committing — resolve this manually (see src/rotateSeed.ts) before starting.`,
    );
  }
}

async function main() {
  await ensureSeedCommitted();
  startHttpServer();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
