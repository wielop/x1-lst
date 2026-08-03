/**
 * Throwaway end-to-end smoke test: start a round, request one reveal, poll
 * for the resolver's answer, then cash out. Not part of the permanent
 * operator toolkit — just used once to prove the deployed program + running
 * resolver actually work together.
 */
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import fs from "node:fs";
import { PROGRAM_ID, RPC_URL, configPda, roundPda } from "./config.js";

const RESOLVER_HTTP_URL = process.env.RESOLVER_HTTP_URL ?? "http://localhost:8787";
import { minesIdl } from "./idl.js";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const player = loadKeypair("../keys/deployer-testnet.json");
  const wallet = new Wallet(player);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(minesIdl, PROGRAM_ID, provider);

  const [config] = configPda();
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID);

  const configAccount: any = await (program.account as any).config.fetch(config);
  const roundId: bigint = BigInt(configAccount.totalRounds.toString());
  const [round] = roundPda(roundId);

  const clientSeed = Array.from(crypto.getRandomValues(new Uint8Array(32)));
  const betLamports = 10_000_000; // 0.01 XNT

  console.log(`starting round ${roundId}...`);
  await program.methods
    .startRound(new BN(betLamports), 3, clientSeed)
    .accounts({ player: player.publicKey, config, vault, round, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("round started, hitting resolver HTTP endpoint for tile 0 (no wallet tx)...");

  const res = await fetch(`${RESOLVER_HTTP_URL}/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roundId: roundId.toString(), tileIndex: 0 }),
  });
  console.log(`resolver responded: ${res.status} ${JSON.stringify(await res.json())}`);

  let roundAccount: any;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    roundAccount = await (program.account as any).round.fetch(round);
    if (roundAccount.revealedBitmap !== 0) break;
  }
  console.log(
    `status=${roundAccount.status} revealedCount=${roundAccount.revealedCount} revealedBitmap=${roundAccount.revealedBitmap}`,
  );

  if (roundAccount.status !== 0) {
    console.log("round ended (busted on the very first tile — bad luck, not a bug). smoke test done.");
    return;
  }

  console.log("cashing out...");
  const mineMint: PublicKey = configAccount.mineMint;
  const [mintAuthority] = PublicKey.findProgramAddressSync([Buffer.from("mint_authority")], PROGRAM_ID);
  const playerMineAta = getAssociatedTokenAddressSync(mineMint, player.publicKey);

  const sig = await program.methods
    .cashOut()
    .accounts({
      player: player.publicKey,
      config,
      vault,
      round,
      mineMint,
      mintAuthority,
      playerMineAta,
      leaderboardPool: configAccount.leaderboardPool,
      rakebackPool: configAccount.rakebackPool,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`cashed out (tx ${sig})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
