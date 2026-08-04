/**
 * Throwaway end-to-end smoke test for Wykop: start a 30s dig, wait for it
 * to finish, hit the resolver's /dig-reveal, confirm $MINE landed. Not part
 * of the permanent operator toolkit.
 */
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import fs from "node:fs";
import { PROGRAM_ID, RPC_URL, configPda, digConfigPda, digSessionPda } from "./config.js";
import { minesIdl } from "./idl.js";

const RESOLVER_HTTP_URL = process.env.RESOLVER_HTTP_URL ?? "http://localhost:8787";

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
  const [digConfig] = digConfigPda();
  const digConfigAccount: any = await (program.account as any).digConfig.fetch(digConfig);
  const sessionId: bigint = BigInt(digConfigAccount.totalSessions.toString());
  const [session] = digSessionPda(sessionId);

  const durationTier = 0; // 30s, cheapest
  const clientSeed = Array.from(crypto.getRandomValues(new Uint8Array(32)));

  console.log(`starting dig session ${sessionId}, tier ${durationTier} (${digConfigAccount.tierDurations[durationTier]}s, ${Number(digConfigAccount.tierPrices[durationTier]) / 1e9} XNT)...`);
  await program.methods
    .startDig(durationTier, clientSeed)
    .accounts({
      player: player.publicKey,
      config,
      digConfig,
      vault: (await import("@solana/web3.js")).PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID)[0],
      session,
      mineMint: digConfigAccount.mineMint,
      playerMineAta: getAssociatedTokenAddressSync(digConfigAccount.mineMint, player.publicKey),
      tokenProgram: (await import("@solana/spl-token")).TOKEN_PROGRAM_ID,
      associatedTokenProgram: (await import("@solana/spl-token")).ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: (await import("@solana/web3.js")).SystemProgram.programId,
    })
    .rpc();
  console.log("dig started, waiting for duration to elapse...");

  const waitMs = (Number(digConfigAccount.tierDurations[durationTier]) + 3) * 1000;
  await new Promise((r) => setTimeout(r, waitMs));

  const ataBefore = await connection.getTokenAccountBalance(
    getAssociatedTokenAddressSync(digConfigAccount.mineMint, player.publicKey),
  ).catch(() => ({ value: { uiAmount: 0 } }));

  console.log("calling /dig-reveal...");
  const res = await fetch(`${RESOLVER_HTTP_URL}/dig-reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sessionId.toString() }),
  });
  const body = await res.json();
  console.log(`resolver responded: ${res.status}`, body);

  const sessionAccount: any = await (program.account as any).digSession.fetch(session);
  console.log(`on-chain session status=${sessionAccount.status} rarityHit=${sessionAccount.rarityHit}`);

  const ataAfter = await connection.getTokenAccountBalance(
    getAssociatedTokenAddressSync(digConfigAccount.mineMint, player.publicKey),
  );
  console.log(
    `$MINE balance: ${ataBefore.value.uiAmount ?? 0} -> ${ataAfter.value.uiAmount} (gained ${(ataAfter.value.uiAmount ?? 0) - (ataBefore.value.uiAmount ?? 0)})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
