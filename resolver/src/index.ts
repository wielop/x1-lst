import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "node:fs";
import { PROGRAM_ID, RPC_URL, RESOLVER_KEYPAIR_PATH, SEED_STORE_PATH, configPda, roundPda } from "./config.js";
import { loadStore, findSeedByHash } from "./seedStore.js";
import { deriveMineSet } from "./mineLayout.js";
import { minesIdl } from "./idl.js";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function bytesToHex(bytes: number[] | Buffer): string {
  return Buffer.from(bytes).toString("hex");
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const resolverKeypair = loadKeypair(RESOLVER_KEYPAIR_PATH);
  const wallet = new Wallet(resolverKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(minesIdl, PROGRAM_ID, provider);

  const [config] = configPda();
  let store = loadStore(SEED_STORE_PATH);

  // Make sure the on-chain commitment matches our local record — first run
  // after a fresh deploy, or if this daemon was restarted with a store that
  // predates the current on-chain config, publish it now.
  const configAccount = await (program.account as any).config.fetch(config);
  const onChainHash = bytesToHex(configAccount.currentSeedHash);
  if (onChainHash !== store.current.hash && onChainHash !== "00".repeat(32)) {
    console.warn(
      `[resolver] local seed store (${store.current.hash}) does not match on-chain commitment (${onChainHash}). ` +
        `Not auto-committing — resolve this manually (see scripts/rotateSeed) before starting.`,
    );
  } else if (onChainHash === "00".repeat(32)) {
    await program.methods
      .commitSeed(Array.from(Buffer.from(store.current.hash, "hex")))
      .accounts({ resolverAuthority: resolverKeypair.publicKey, config })
      .rpc();
    console.log(`[resolver] committed initial seed hash ${store.current.hash}`);
  }

  console.log(`[resolver] listening for RevealRequested on ${PROGRAM_ID.toBase58()}`);

  program.addEventListener("RevealRequested", async (event: any) => {
    const roundId: bigint = BigInt(event.roundId.toString());
    const tileIndex: number = event.tileIndex;
    const clientSeed = Buffer.from(event.clientSeed);
    const seedCommitment = bytesToHex(event.seedCommitment);

    try {
      const record = findSeedByHash(store, seedCommitment);
      if (!record) {
        console.error(`[resolver] round ${roundId}: unknown seed commitment ${seedCommitment}, refusing to resolve`);
        return;
      }

      const [round] = roundPda(roundId);
      const roundAccount = await (program.account as any).round.fetch(round);
      const mineCount: number = roundAccount.mineCount;

      const mineSet = deriveMineSet(Buffer.from(record.raw, "hex"), roundId, clientSeed, mineCount);
      const isMine = mineSet.has(tileIndex);

      await program.methods
        .resolveReveal(tileIndex, isMine)
        .accounts({ resolverAuthority: resolverKeypair.publicKey, config, round })
        .rpc();

      console.log(`[resolver] round ${roundId} tile ${tileIndex} -> ${isMine ? "MINE" : "safe"}`);
    } catch (err) {
      console.error(`[resolver] failed to resolve round ${roundId} tile ${tileIndex}`, err);
    }
  });

  // Reload the store periodically in case rotateSeed/revealSeed ran out-of-process.
  setInterval(() => {
    store = loadStore(SEED_STORE_PATH);
  }, 15_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
