import http from "node:http";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import { PROGRAM_ID, RPC_URL, RESOLVER_KEYPAIR_PATH, SEED_STORE_PATH, configPda, roundPda } from "./config.js";
import { loadStore, findSeedByHash, type SeedStoreData } from "./seedStore.js";
import { deriveMineSet } from "./mineLayout.js";
import { minesIdl } from "./idl.js";

const PORT = Number(process.env.RESOLVER_PORT ?? 8787);

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function bytesToHex(bytes: number[] | Buffer): string {
  return Buffer.from(bytes).toString("hex");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

/**
 * Starts the HTTP server tile clicks hit directly — no on-chain transaction,
 * no wallet popup. Only the resolver's own `resolve_reveal` call (signed by
 * its own keypair) ever touches the chain for a reveal.
 */
export function startHttpServer(): void {
  const connection = new Connection(RPC_URL, "confirmed");
  const resolverKeypair = loadKeypair(RESOLVER_KEYPAIR_PATH);
  const wallet = new Wallet(resolverKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(minesIdl, PROGRAM_ID, provider);
  const [config] = configPda();

  let store: SeedStoreData = loadStore(SEED_STORE_PATH);
  setInterval(() => {
    store = loadStore(SEED_STORE_PATH);
  }, 15_000);

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, program: PROGRAM_ID.toBase58() });
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/round-layout") {
      try {
        const roundId = BigInt(url.searchParams.get("roundId") ?? "-1");
        const [round] = roundPda(roundId);
        const roundAccount: any = await (program.account as any).round.fetch(round);

        // Only ever reveal the full mine layout for a round that has
        // already ended (Busted or CashedOut). Serving this for an Active
        // round would hand the player exactly the read-before-you-click
        // exploit this whole commit-reveal architecture exists to prevent.
        if (roundAccount.status === 0) {
          sendJson(res, 409, { error: "round is still active, layout withheld" });
          return;
        }

        const seedCommitment = bytesToHex(roundAccount.seedCommitment);
        const record = findSeedByHash(store, seedCommitment);
        if (!record) {
          sendJson(res, 500, { error: "unknown seed commitment for this round" });
          return;
        }

        const clientSeed = Buffer.from(roundAccount.clientSeed);
        const mineCount: number = roundAccount.mineCount;
        const mineSet = deriveMineSet(Buffer.from(record.raw, "hex"), roundId, clientSeed, mineCount);
        sendJson(res, 200, { mines: [...mineSet].sort((a, b) => a - b) });
      } catch (err: any) {
        sendJson(res, 500, { error: String(err.message ?? err) });
      }
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/reveal") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

      const roundId = BigInt(body.roundId);
      const tileIndex = Number(body.tileIndex);
      if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex > 24) {
        sendJson(res, 400, { error: "tileIndex out of range" });
        return;
      }

      const [round] = roundPda(roundId);
      const roundAccount: any = await (program.account as any).round.fetch(round);

      if (roundAccount.status !== 0) {
        sendJson(res, 409, { error: "round is not active" });
        return;
      }
      const bit = 1 << tileIndex;
      if ((roundAccount.revealedBitmap & bit) !== 0) {
        sendJson(res, 409, { error: "tile already revealed" });
        return;
      }

      const seedCommitment = bytesToHex(roundAccount.seedCommitment);
      const record = findSeedByHash(store, seedCommitment);
      if (!record) {
        sendJson(res, 500, { error: "unknown seed commitment for this round" });
        return;
      }

      const clientSeed = Buffer.from(roundAccount.clientSeed);
      const mineCount: number = roundAccount.mineCount;
      const mineSet = deriveMineSet(Buffer.from(record.raw, "hex"), roundId, clientSeed, mineCount);
      const isMine = mineSet.has(tileIndex);

      await program.methods
        .resolveReveal(tileIndex, isMine)
        .accounts({ resolverAuthority: resolverKeypair.publicKey, config, round })
        .rpc();

      console.log(`[resolver] round ${roundId} tile ${tileIndex} -> ${isMine ? "MINE" : "safe"}`);
      sendJson(res, 200, { isMine });
    } catch (err: any) {
      console.error("[resolver] /reveal failed", err);
      sendJson(res, 500, { error: String(err.message ?? err) });
    }
  });

  server.listen(PORT, () => {
    console.log(`[resolver] HTTP server listening on :${PORT}`);
  });
}
