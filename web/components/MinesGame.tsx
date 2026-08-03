"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN, type Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  PROGRAM_ID,
  TOTAL_TILES,
  GRID_SIZE,
  configPda,
  vaultPda,
  roundPda,
  fairMultiplier,
} from "@/lib/config";
import idl from "@/lib/idl/mines.json";

type TileState = "hidden" | "pending" | "safe" | "mine";

const HOUSE_EDGE_BPS = 200; // mirrors on-chain default; overwritten once config loads
const REVEAL_TIMEOUT_MS = 20_000; // if the resolver hasn't answered by then, something's wrong

export function MinesGame() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [betAmount, setBetAmount] = useState("0.5");
  const [mineCount, setMineCount] = useState(3);
  const [tiles, setTiles] = useState<TileState[]>(Array(TOTAL_TILES).fill("hidden"));
  const [roundId, setRoundId] = useState<bigint | null>(null);
  const [clientSeed, setClientSeed] = useState<Buffer | null>(null);
  const [revealedCount, setRevealedCount] = useState(0);
  const [status, setStatus] = useState<"idle" | "active" | "busted" | "cashed_out">("idle");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingSince, setPendingSince] = useState<Record<number, number>>({});
  const [stuckTiles, setStuckTiles] = useState<Set<number>>(new Set());

  const appendLog = useCallback((msg: string) => {
    setLog((prev) => [msg, ...prev].slice(0, 8));
  }, []);

  const program = useMemo(() => {
    if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) return null;
    const provider = new AnchorProvider(
      connection,
      {
        publicKey: wallet.publicKey,
        signTransaction: wallet.signTransaction,
        signAllTransactions: wallet.signAllTransactions,
      },
      { commitment: "confirmed" },
    );
    return new Program(idl as Idl, PROGRAM_ID, provider);
  }, [connection, wallet.publicKey, wallet.signTransaction, wallet.signAllTransactions]);

  const currentMultiplier = revealedCount > 0 ? fairMultiplier(revealedCount, mineCount) * (1 - HOUSE_EDGE_BPS / 10_000) : 1;
  const currentPayout = revealedCount > 0 ? Number(betAmount) * currentMultiplier : 0;

  const startRound = useCallback(async () => {
    if (!program || !wallet.publicKey) return;
    setBusy(true);
    try {
      const [config] = configPda();
      const [vault] = vaultPda();
      const configAccount = await (program.account as any).config.fetch(config);
      const newRoundId: bigint = BigInt(configAccount.totalRounds.toString());
      const [round] = roundPda(newRoundId);

      const seed = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
      const betLamports = Math.round(Number(betAmount) * 1_000_000_000);

      await program.methods
        .startRound(new BN(betLamports), mineCount, Array.from(seed))
        .accounts({
          player: wallet.publicKey,
          config,
          vault,
          round,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setRoundId(newRoundId);
      setClientSeed(seed);
      setTiles(Array(TOTAL_TILES).fill("hidden"));
      setRevealedCount(0);
      setPendingSince({});
      setStuckTiles(new Set());
      setError(null);
      setStatus("active");
      appendLog(`round ${newRoundId} started, bet ${betAmount} XNT, ${mineCount} mines`);
    } catch (err: any) {
      setError(`Could not start round: ${err.message ?? err}`);
      appendLog(`start_round failed: ${err.message ?? err}`);
    } finally {
      setBusy(false);
    }
  }, [program, wallet.publicKey, betAmount, mineCount, appendLog]);

  const revealTile = useCallback(
    async (index: number) => {
      if (!program || !wallet.publicKey || roundId === null || status !== "active") return;
      if (tiles[index] !== "hidden") return;
      setBusy(true);
      setError(null);
      setTiles((prev) => {
        const next = [...prev];
        next[index] = "pending";
        return next;
      });
      setPendingSince((prev) => ({ ...prev, [index]: Date.now() }));
      try {
        const [round] = roundPda(roundId);
        await program.methods
          .requestReveal(index)
          .accounts({ player: wallet.publicKey, round })
          .rpc();
        appendLog(`requested tile ${index}, waiting for resolver...`);
        // Resolver settles this off-chain and submits resolve_reveal; we
        // pick the outcome up by polling the round account below.
      } catch (err: any) {
        setError(`Tile ${index} request failed: ${err.message ?? err}`);
        appendLog(`request_reveal failed: ${err.message ?? err}`);
        setTiles((prev) => {
          const next = [...prev];
          next[index] = "hidden";
          return next;
        });
        setPendingSince((prev) => {
          const next = { ...prev };
          delete next[index];
          return next;
        });
      } finally {
        setBusy(false);
      }
    },
    [program, wallet.publicKey, roundId, status, tiles, appendLog],
  );

  const cashOut = useCallback(async () => {
    if (!program || !wallet.publicKey || roundId === null) return;
    setBusy(true);
    try {
      const [config] = configPda();
      const [vault] = vaultPda();
      const [round] = roundPda(roundId);
      const configAccount = await (program.account as any).config.fetch(config);
      const mineMint: PublicKey = configAccount.mineMint;
      const leaderboardPool: PublicKey = configAccount.leaderboardPool;
      const rakebackPool: PublicKey = configAccount.rakebackPool;
      const [mintAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority")],
        PROGRAM_ID,
      );
      const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import(
        "@solana/spl-token"
      );
      const playerMineAta = getAssociatedTokenAddressSync(mineMint, wallet.publicKey);

      await program.methods
        .cashOut()
        .accounts({
          player: wallet.publicKey,
          config,
          vault,
          round,
          mineMint,
          mintAuthority,
          playerMineAta,
          leaderboardPool,
          rakebackPool,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setStatus("cashed_out");
      appendLog(`cashed out at ${currentMultiplier.toFixed(3)}x -> ${currentPayout.toFixed(4)} XNT`);
    } catch (err: any) {
      setError(`Cash out failed: ${err.message ?? err}`);
      appendLog(`cash_out failed: ${err.message ?? err}`);
    } finally {
      setBusy(false);
    }
  }, [program, wallet.publicKey, roundId, currentMultiplier, currentPayout, appendLog]);

  // Poll the round account while a round is active to pick up resolver-side
  // resolve_reveal / bust updates without needing a websocket log parser.
  useEffect(() => {
    if (!program || roundId === null || status !== "active") return;
    const [round] = roundPda(roundId);
    const interval = setInterval(async () => {
      try {
        const account: any = await (program.account as any).round.fetch(round);
        const revealedBitmap: number = account.revealedBitmap;
        const newRevealedCount: number = account.revealedCount;
        const roundStatus: number = account.status; // 0 Active, 1 CashedOut, 2 Busted

        setTiles((prev) => {
          const next = [...prev];
          for (let i = 0; i < TOTAL_TILES; i++) {
            if ((revealedBitmap & (1 << i)) !== 0 && next[i] === "pending") {
              next[i] = roundStatus === 2 ? "mine" : "safe";
            }
          }
          return next;
        });
        setRevealedCount(newRevealedCount);
        if (roundStatus === 2) {
          setStatus("busted");
          appendLog("boom — round busted");
        }

        // A tile stuck in "pending" for too long means the resolver isn't
        // answering (wrong program id, resolver down, etc.) — surface that
        // instead of leaving the player staring at "…" forever.
        const now = Date.now();
        const stillStuck = new Set<number>();
        for (const [idxStr, since] of Object.entries(pendingSince)) {
          const idx = Number(idxStr);
          if ((revealedBitmap & (1 << idx)) === 0 && now - since > REVEAL_TIMEOUT_MS) {
            stillStuck.add(idx);
          }
        }
        if (stillStuck.size > 0) {
          setStuckTiles(stillStuck);
          setError("The resolver isn't answering. It may be down, or pointed at a different deployment than this page — check that the resolver daemon is running and watching this program id.");
        }
      } catch {
        // round account not found yet / RPC hiccup, ignore and retry next tick
      }
    }, 1200);
    return () => clearInterval(interval);
  }, [program, roundId, status, appendLog, pendingSince]);

  const statusMessage = !wallet.publicKey
    ? "Connect a wallet to play."
    : status === "idle"
      ? "Pick a bet and a mine count, then Start round."
      : status === "active"
        ? revealedCount === 0
          ? "Round started — click any tile. Safe tiles raise your multiplier; you can cash out after the first one."
          : "Click another tile to push your multiplier higher, or cash out now to lock in the win."
        : status === "busted"
          ? "Hit a mine — the bet is lost. Start a new round to try again."
          : "Cashed out. Start a new round whenever you're ready.";

  return (
    <div className="mines-app">
      <header>
        <h1>Mines</h1>
        <WalletMultiButton />
      </header>

      <p className="rules">
        Grid of {TOTAL_TILES} tiles, some hidden as mines. Reveal tiles one at a time — each safe one raises your
        payout multiplier. Cash out any time, or lose the bet if you hit a mine. More mines chosen = higher
        multiplier per tile, but a shorter safe streak.
      </p>

      <div className="controls">
        <label>
          Bet (XNT)
          <input value={betAmount} onChange={(e) => setBetAmount(e.target.value)} disabled={status === "active"} />
        </label>
        <label>
          Mines
          <input
            type="number"
            min={1}
            max={24}
            value={mineCount}
            onChange={(e) => setMineCount(Number(e.target.value))}
            disabled={status === "active"}
          />
          <span className="hint">
            {mineCount} of {TOTAL_TILES} tiles are mines — next safe tile pays{" "}
            {(fairMultiplier(1, mineCount) * (1 - HOUSE_EDGE_BPS / 10_000)).toFixed(2)}x. More mines = bigger
            multiplier per tile, but a much higher chance of hitting one early.
          </span>
        </label>
        {status !== "active" ? (
          <button onClick={startRound} disabled={busy || !program}>
            Start round
          </button>
        ) : (
          <button onClick={cashOut} disabled={busy || revealedCount === 0} className="cashout">
            Cash out {currentPayout.toFixed(4)} XNT ({currentMultiplier.toFixed(3)}x)
          </button>
        )}
      </div>

      <p className={`status-banner status-${status}`}>{statusMessage}</p>
      {error && <p className="error-banner">{error}</p>}

      <div className="grid" style={{ gridTemplateColumns: `repeat(${GRID_SIZE}, 1fr)` }}>
        {tiles.map((t, i) => (
          <button
            key={i}
            className={`tile ${t}${stuckTiles.has(i) ? " stuck" : ""}`}
            disabled={busy || status !== "active" || t !== "hidden"}
            onClick={() => revealTile(i)}
            title={t === "pending" ? "waiting for resolver..." : undefined}
          >
            {t === "safe" ? "★" : t === "mine" ? "✸" : t === "pending" ? (stuckTiles.has(i) ? "!" : "…") : ""}
          </button>
        ))}
      </div>

      <div className="log">
        {log.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    </div>
  );
}
