/**
 * Operator tool: triggers a Rebalance on one Label. Deliberately not exposed
 * as a public button in the app — only the Label's creator key can build a
 * Rebalance the program will actually accept (see
 * label-vault/program/src/processor.rs::process_rebalance), so this is meant
 * to be run by whoever holds that key, by hand or from a cron job once per
 * epoch.
 *
 * Usage: npx tsx scripts/rebalance-label.ts <LABEL_VAULT_CONFIG_ADDRESS>
 *   (reads the creator keypair from CREATOR_KEYPAIR_PATH, default
 *   ~/x1-lst/keys/deployer-testnet.json)
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import { buildRebalanceTransaction, getVaultConfig } from "../lib/labelVault";
import { POOL_CONFIG } from "../lib/poolConfig";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const vaultConfigArg = process.argv[2];
  if (!vaultConfigArg) {
    console.error("Usage: npx tsx scripts/rebalance-label.ts <LABEL_VAULT_CONFIG_ADDRESS>");
    process.exit(1);
  }
  const vaultConfigAddress = new PublicKey(vaultConfigArg);
  const keypairPath =
    process.env.CREATOR_KEYPAIR_PATH || process.env.HOME + "/x1-lst/keys/deployer-testnet.json";
  const creator = loadKeypair(keypairPath);

  const connection = new Connection(POOL_CONFIG.rpcUrl, "confirmed");

  const before = await getVaultConfig(connection, vaultConfigAddress);
  if (!before) {
    console.error("Label not found:", vaultConfigAddress.toBase58());
    process.exit(1);
  }
  console.log(`Rebalancing "${before.name}" (${before.symbol})`);
  console.log("weights before:", before.allocations.map((a) => `${a.poolAddress.toBase58().slice(0, 8)}…=${a.weightBps / 100}%`));

  const { instructions } = await buildRebalanceTransaction(connection, creator.publicKey, vaultConfigAddress);
  const tx = new Transaction().add(...instructions);
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = creator.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [creator], { commitment: "confirmed" });
  console.log("Rebalance signature:", sig);

  const after = await getVaultConfig(connection, vaultConfigAddress);
  console.log("weights after:", after!.allocations.map((a) => `${a.poolAddress.toBase58().slice(0, 8)}…=${a.weightBps / 100}%`));
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
