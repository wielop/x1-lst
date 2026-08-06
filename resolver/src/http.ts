import http from "node:http";
import crypto from "node:crypto";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "node:fs";
import {
  PROGRAM_ID,
  RPC_URL,
  RESOLVER_KEYPAIR_PATH,
  SEED_STORE_PATH,
  configPda,
  roundPda,
  digConfigPda,
  digSessionPda,
  mintAuthorityPda,
  liquidityPoolPda,
  poolXntVaultPda,
  poolMineVaultPda,
} from "./config.js";
import { loadStore, findSeedByHash, type SeedStoreData } from "./seedStore.js";
import { deriveMineSet } from "./mineLayout.js";
import { deriveDigOutcome, type RarityTierConfig } from "./digOutcome.js";
import { minesIdl } from "./idl.js";

const PORT = Number(process.env.RESOLVER_PORT ?? 8787);

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function bytesToHex(bytes: number[] | Buffer): string {
  return Buffer.from(bytes).toString("hex");
}

/** The chain's own `Clock::get()?.unix_timestamp` — which is what
 * `resolve_dig`'s `elapsed >= required` check actually runs against — can
 * lag the resolver's wall clock by a second or more on a lightly-loaded
 * testnet (slot times aren't a perfect 400ms). Checking against
 * `Date.now()` let the resolver fire a fraction of a second "early" by the
 * chain's own reckoning, which the program then rejects with
 * `DigNotFinished`. Falls back to wall-clock (never lags the *real* time,
 * so it can only make us wait a little longer, never fire early) if the
 * RPC call itself fails. */
async function getClusterUnixTime(connection: Connection): Promise<number> {
  try {
    const slot = await connection.getSlot("confirmed");
    const blockTime = await connection.getBlockTime(slot);
    if (blockTime != null) return blockTime;
  } catch {
    // fall through to wall-clock fallback
  }
  return Math.floor(Date.now() / 1000);
}

function isDigNotFinished(err: any): boolean {
  const msg = String(err?.message ?? err);
  return msg.includes("DigNotFinished") || msg.includes("6012");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

// Standard SPKI DER prefix for a raw 32-byte Ed25519 public key — lets
// Node's built-in crypto.verify handle Ed25519 without pulling in a
// tweetnacl dependency the resolver doesn't otherwise have.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Verifies that `signatureB64` is a valid Ed25519 signature by `owner`
 * over `message` — proves whoever called this HTTP endpoint actually
 * controls the round/session's own wallet, via wallet.signMessage() on the
 * client (an off-chain signature, no transaction/fee), rather than the
 * unauthenticated free-for-all this endpoint used to be. See the
 * SECURITY NOTE above /reveal for what this closes.
 */
function verifyOwnerSignature(message: string, signatureB64: string | undefined, owner: PublicKey): boolean {
  if (!signatureB64) return false;
  try {
    const der = Buffer.concat([ED25519_SPKI_PREFIX, owner.toBuffer()]);
    const keyObject = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message, "utf-8"), keyObject, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
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

    if (req.method === "POST" && url.pathname === "/dig-reveal") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

        const sessionId = BigInt(body.sessionId);
        const [session] = digSessionPda(sessionId);
        const [digConfig] = digConfigPda();

        const sessionAccount: any = await (program.account as any).digSession.fetch(session);
        const digConfigAccount: any = await (program.account as any).digConfig.fetch(digConfig);

        if (sessionAccount.status !== 0) {
          sendJson(res, 409, { error: "dig session is not active" });
          return;
        }

        // SECURITY: this endpoint has no on-chain transaction/fee gating
        // it — that's the whole point (one wallet-signed tx total per
        // session: start_dig). But that also used to mean ANYONE could
        // POST any sessionId here and force-settle someone else's dig the
        // instant its timer elapsed, with no way to prove they were the
        // session's own player. Confirmed exploitable via a live
        // adversarial-persona test. Fixed with an off-chain Ed25519
        // signature (wallet.signMessage, no transaction/fee) proving the
        // caller actually controls `sessionAccount.player`.
        if (
          !verifyOwnerSignature(`mines-dig-reveal:${sessionId.toString()}`, body.signature, sessionAccount.player)
        ) {
          sendJson(res, 401, { error: "missing or invalid owner signature" });
          return;
        }

        const requiredSeconds = digConfigAccount.tierDurations[sessionAccount.durationTier];
        const clusterNow = await getClusterUnixTime(connection);
        const elapsedSeconds = clusterNow - Number(sessionAccount.startTs);
        if (elapsedSeconds < requiredSeconds) {
          sendJson(res, 409, {
            error: "dig session hasn't finished yet",
            secondsRemaining: requiredSeconds - elapsedSeconds,
          });
          return;
        }

        const seedCommitment = bytesToHex(sessionAccount.seedCommitment);
        const record = findSeedByHash(store, seedCommitment);
        if (!record) {
          sendJson(res, 500, { error: "unknown seed commitment for this session" });
          return;
        }

        const activeCount: number = digConfigAccount.activeRarityCount;
        const rarityTiers: RarityTierConfig[] = digConfigAccount.rarityTiers.slice(0, activeCount).map((t: any) => ({
          rewardBps: t.rewardBps,
          baseChanceBps: t.baseChanceBps,
          durationScaling: t.durationScaling,
        }));

        const clientSeed = Buffer.from(sessionAccount.clientSeed);
        const rarityHit = deriveDigOutcome(
          Buffer.from(record.raw, "hex"),
          sessionId,
          clientSeed,
          sessionAccount.durationTier,
          rarityTiers,
        );

        const config_ = configPda()[0];
        const mintAuthority = mintAuthorityPda()[0];
        const playerMineAta = getAssociatedTokenAddressSync(digConfigAccount.mineMint, sessionAccount.player);
        const [liquidityPool] = liquidityPoolPda();
        const [poolXntVault] = poolXntVaultPda();
        const [poolMineVault] = poolMineVaultPda();

        // Belt-and-suspenders on top of the getClusterUnixTime check above:
        // that check and this .rpc() aren't atomic, so on a slow/stalled
        // slot the chain's clock could still not have ticked over by the
        // time this instruction actually executes. Retry a few times on
        // DigNotFinished specifically (never on any other error) instead of
        // bouncing the player straight to a "Something went wrong" screen
        // for what's really just "not quite yet".
        for (let attempt = 0; ; attempt++) {
          try {
            await program.methods
              .resolveDig(rarityHit)
              .accounts({
                resolverAuthority: resolverKeypair.publicKey,
                config: config_,
                digConfig,
                session,
                mineMint: digConfigAccount.mineMint,
                mintAuthority,
                player: sessionAccount.player,
                playerMineAta,
                poolXntVault,
                poolMineVault,
                liquidityPool,
                tokenProgram: TOKEN_PROGRAM_ID,
              })
              .rpc();
            break;
          } catch (err) {
            if (!isDigNotFinished(err) || attempt >= 4) throw err;
            await new Promise((r) => setTimeout(r, 1_500));
          }
        }

        console.log(`[resolver] dig session ${sessionId} -> rarity ${rarityHit === 0xff ? "none" : rarityHit}`);
        sendJson(res, 200, { rarityHit });
      } catch (err: any) {
        console.error("[resolver] /dig-reveal failed", err);
        sendJson(res, 500, { error: String(err.message ?? err) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/register-round-secret") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        const roundId = BigInt(body.roundId);
        const secret = String(body.secret ?? "");
        if (!secret || secret.length < 16) {
          sendJson(res, 400, { error: "secret missing or too short" });
          return;
        }
        const key = roundId.toString();
        if (roundSecrets.has(key)) {
          // First-write-wins — see the comment above roundSecrets. A
          // second registration attempt for the same round is either a
          // (harmless) client retry or someone trying to hijack a round
          // they didn't start; either way, don't overwrite an existing
          // claim.
          sendJson(res, 409, { error: "round already has a registered secret" });
          return;
        }
        const [round] = roundPda(roundId);
        const roundAccount: any = await (program.account as any).round.fetch(round).catch(() => null);
        if (!roundAccount || roundAccount.status !== 0) {
          sendJson(res, 409, { error: "round not active" });
          return;
        }
        roundSecrets.set(key, secret);
        sendJson(res, 200, { ok: true });
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

      // See the roundSecrets comment above /register-round-secret: without
      // this, roundId alone (a small public sequential counter) was enough
      // for anyone to force-reveal tiles on someone else's round.
      const registeredSecret = roundSecrets.get(roundId.toString());
      if (!registeredSecret || registeredSecret !== String(body.revealSecret ?? "")) {
        sendJson(res, 403, { error: "missing or invalid revealSecret for this round" });
        return;
      }

      const [round] = roundPda(roundId);
      const roundAccount: any = await (program.account as any).round.fetch(round);

      if (roundAccount.status !== 0) {
        sendJson(res, 409, { error: "round is not active" });
        return;
      }

      // SECURITY: same issue and same fix as /dig-reveal above — this used
      // to accept a reveal request for ANY active round from anyone, no
      // proof the caller was that round's own player. That meant any
      // wallet could force a reveal (and potentially a bust) on someone
      // else's round without their consent — a real griefing/DoS vector,
      // confirmed exploitable via a live adversarial-persona test. Fixed
      // the same way: an off-chain Ed25519 signature over the request,
      // verified against roundAccount.player.
      if (!verifyOwnerSignature(`mines-reveal:${roundId.toString()}:${tileIndex}`, body.signature, roundAccount.player)) {
        sendJson(res, 401, { error: "missing or invalid owner signature" });
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
