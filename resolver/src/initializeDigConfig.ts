/**
 * One-time admin setup for the Wykop (time-based mining) game mode. Run
 * once, after the program upgrade that added start_dig/resolve_dig has
 * been deployed and Mines' own config/mint already exist.
 *
 * Launch tier economics (tunable later via update_dig_tiers /
 * update_rarity_tiers, no redeploy needed):
 *   - 30s / 60s / 90s digs priced at 0.05 / 0.10 / 0.15 XNT
 *   - Rare tier: floor x2 payout, base 15% chance, scaling 1x/1.8x/3x by
 *     duration tier (15% / 27% / 45% effective)
 *   - Epic tier: floor x6 payout, base 2% chance, scaling 1x/2.5x/6x by
 *     duration tier (2% / 5% / 12% effective)
 * Longer digs get a genuinely better shot at the rare tiers, not just more
 * attempts — this is the "commit longer, better odds" hook from the design.
 */
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import fs from "node:fs";
import { PROGRAM_ID, RPC_URL, configPda, digConfigPda } from "./config.js";
import { minesIdl } from "./idl.js";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const ADMIN_KEYPAIR_PATH = process.env.ADMIN_KEYPAIR_PATH ?? "../keys/deployer-testnet.json";
const LAMPORTS_PER_XNT = 1_000_000_000;

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const adminKeypair = loadKeypair(ADMIN_KEYPAIR_PATH);
  const wallet = new Wallet(adminKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(minesIdl, PROGRAM_ID, provider);

  const [config] = configPda();
  const [digConfig] = digConfigPda();

  const tierPrices = [0.05, 0.1, 0.15].map((xnt) => new BN(Math.round(xnt * LAMPORTS_PER_XNT)));
  const tierDurations = [30, 60, 90];

  const rarityTiers = [
    { rewardBps: 10_000, baseChanceBps: 1_500, durationScaling: [10_000, 18_000, 30_000] }, // Rare
    { rewardBps: 50_000, baseChanceBps: 200, durationScaling: [10_000, 25_000, 60_000] }, // Epic
  ];

  const sig = await program.methods
    .initializeDigConfig(tierPrices, tierDurations, rarityTiers)
    .accounts({
      admin: adminKeypair.publicKey,
      config,
      digConfig,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`dig config initialized (tx ${sig})`);
  console.log(`dig config: ${digConfig.toBase58()}`);
  console.log(`tier prices (XNT): 0.05 / 0.10 / 0.15`);
  console.log(`tier durations (s): 30 / 60 / 90`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
