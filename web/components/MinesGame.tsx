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
  stakingPoolPda,
  rewardVaultPda,
} from "@/lib/config";
import idl from "@/lib/idl/mines.json";

type TileState = "hidden" | "pending" | "safe" | "mine" | "safe-unclicked" | "mine-unclicked";
type RoundResult = { type: "win"; payout: number; multiplier: number; mineEarned: number } | { type: "lose"; lost: number };

const HOUSE_EDGE_BPS = 200; // mirrors on-chain default; overwritten once config loads
const REVEAL_TIMEOUT_MS = 20_000; // if the resolver hasn't answered by then, something's wrong

/** Green -> red as risk climbs, so the number itself communicates the stakes. */
function riskColor(mineCount: number): string {
  if (mineCount <= 3) return "#4ade80";
  if (mineCount <= 8) return "#a3e635";
  if (mineCount <= 14) return "#fb923c";
  return "#f87171";
}

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
  const [mineBalance, setMineBalance] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<RoundResult | null>(null);
  // Locked in at start_round — the "Mines" input becomes editable again as
  // soon as a round ends, so it can drift to a different value (the DRAFT
  // for the *next* round) while the board on screen still shows the result
  // of the round just played. Without this, the displayed mine count and
  // the board's actual mine count can visibly disagree, which reads as a
  // fairness bug even though the underlying game data was always correct.
  const [playedMineCount, setPlayedMineCount] = useState<number | null>(null);

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

  const currentMultiplier =
    revealedCount > 0 ? fairMultiplier(revealedCount, playedMineCount ?? mineCount) * (1 - HOUSE_EDGE_BPS / 10_000) : 1;
  const currentPayout = revealedCount > 0 ? Number(betAmount) * currentMultiplier : 0;

  const startRound = useCallback(async () => {
    if (!program || !wallet.publicKey) return;
    setBusy(true);
    try {
      const [config] = configPda();
      const [vault] = vaultPda();
      const [stakingPool] = stakingPoolPda();
      const [rewardVault] = rewardVaultPda();

      const seed = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
      const betLamports = Math.round(Number(betAmount) * 1_000_000_000);

      // Catch "can't actually afford this bet" client-side with a plain-
      // language message instead of letting it hit the chain and come back
      // as a raw "Transaction simulation failed: ... insufficient funds for
      // rent" — accurate, but leaks Solana jargon a player shouldn't need
      // to know. FEE_RESERVE_LAMPORTS is a generous buffer over the actual
      // ~5000-lamport tx fee, since the exact rent/fee cost isn't worth
      // computing precisely here — found via the swarm load test (a
      // streak-chasing persona that raises its bet after each win
      // eventually bet down to its last few thousand lamports).
      const FEE_RESERVE_LAMPORTS = 5_000_000; // 0.005 XNT
      const walletBalance = await connection.getBalance(wallet.publicKey);
      if (betLamports + FEE_RESERVE_LAMPORTS > walletBalance) {
        throw new Error(
          `Not enough XNT: bet is ${betAmount}, you have ${(walletBalance / 1e9).toFixed(4)} (need a little extra for fees).`,
        );
      }

      // `round`'s PDA is seeded with config.total_rounds read LIVE on-chain
      // at instruction-execution time (see StartRound in lib.rs), not
      // anything the client can pin down in advance. Under concurrent play
      // — another wallet's start_round lands between our read and ours
      // executing — the counter's already moved on by the time our tx runs,
      // so the round address we precomputed no longer matches what the
      // program now expects: AnchorError ConstraintSeeds (2006). Nothing
      // was spent (the whole instruction reverts), so it's safe to just
      // re-read the counter and retry — surfaced under the swarm load test
      // as a real concurrency bug real simultaneous players would also hit.
      let newRoundId: bigint;
      for (let attempt = 0; ; attempt++) {
        const configAccount = await (program.account as any).config.fetch(config);
        newRoundId = BigInt(configAccount.totalRounds.toString());
        const [round] = roundPda(newRoundId);
        try {
          await program.methods
            .startRound(new BN(betLamports), mineCount, Array.from(seed))
            .accounts({
              player: wallet.publicKey,
              config,
              vault,
              round,
              stakingPool,
              rewardVault,
              systemProgram: SystemProgram.programId,
            })
            .rpc();
          break;
        } catch (err: any) {
          const isSeedsRace = String(err.message ?? err).includes("ConstraintSeeds") || String(err.message ?? err).includes("2006");
          if (!isSeedsRace || attempt >= 4) throw err;
        }
      }

      setRoundId(newRoundId);
      setClientSeed(seed);
      setPlayedMineCount(mineCount);
      setTiles(Array(TOTAL_TILES).fill("hidden"));
      setRevealedCount(0);
      setPendingSince({});
      setStuckTiles(new Set());
      setError(null);
      setLastResult(null);
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
      if (!wallet.publicKey || roundId === null || status !== "active") return;
      if (tiles[index] !== "hidden") return;
      setError(null);
      setTiles((prev) => {
        const next = [...prev];
        next[index] = "pending";
        return next;
      });
      setPendingSince((prev) => ({ ...prev, [index]: Date.now() }));
      try {
        // Plain HTTP call, no wallet transaction: the resolver settles this
        // and submits resolve_reveal itself, signed with its own key. We
        // pick up the outcome by polling the round account below — this
        // keeps clicking through a round to a total of 2 wallet-signed
        // transactions (start_round, cash_out) no matter how many tiles.
        //
        // This endpoint has no on-chain transaction to prove who's asking,
        // which used to mean it had NO auth at all — any wallet could POST
        // any roundId and force a reveal on someone else's round. Fixed
        // with a wallet.signMessage() signature (off-chain, no transaction
        // or fee) over the exact roundId+tileIndex, which the resolver
        // verifies against the round's actual owner before acting.
        if (!wallet.signMessage) {
          throw new Error("This wallet doesn't support message signing, which reveals now require for security.");
        }
        const message = `mines-reveal:${roundId.toString()}:${index}`;
        const signatureBytes = await wallet.signMessage(new TextEncoder().encode(message));
        const signature = Buffer.from(signatureBytes).toString("base64");

        const res = await fetch(`/api/reveal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roundId: roundId.toString(), tileIndex: index, player: wallet.publicKey.toBase58(), signature }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `resolver returned ${res.status}`);
        }
        appendLog(`tile ${index} sent to resolver...`);
      } catch (err: any) {
        setError(`Tile ${index} request failed: ${err.message ?? err}`);
        appendLog(`reveal failed: ${err.message ?? err}`);
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
      }
    },
    [wallet.publicKey, wallet.signMessage, roundId, status, tiles, appendLog],
  );

  const revealFullLayout = useCallback(async (finishedRoundId: bigint) => {
    // Only ever called after a round has ended (busted/cashed_out) — the
    // resolver itself refuses to answer this for a still-active round, see
    // the comment in resolver/src/http.ts on GET /round-layout.
    try {
      const res = await fetch(`/api/round-layout?roundId=${finishedRoundId.toString()}`);
      if (!res.ok) return;
      const { mines }: { mines: number[] } = await res.json();
      const mineSet = new Set(mines);
      setTiles((prev) => {
        const next = [...prev];
        for (let i = 0; i < TOTAL_TILES; i++) {
          if (next[i] === "hidden") {
            next[i] = mineSet.has(i) ? "mine-unclicked" : "safe-unclicked";
          }
        }
        return next;
      });
    } catch {
      // best-effort cosmetic reveal — not worth surfacing an error banner for
    }
  }, []);

  const refreshMineBalance = useCallback(async (): Promise<number | null> => {
    if (!program || !wallet.publicKey) return null;
    try {
      const [config] = configPda();
      const configAccount: any = await (program.account as any).config.fetch(config);
      const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
      const ata = getAssociatedTokenAddressSync(configAccount.mineMint, wallet.publicKey);
      const info = await connection.getTokenAccountBalance(ata).catch(() => null);
      const value = info ? info.value.uiAmount ?? 0 : 0;
      setMineBalance(value);
      return value;
    } catch {
      // config not initialized yet, or RPC hiccup — leave balance as-is
      return null;
    }
  }, [program, wallet.publicKey, connection]);

  useEffect(() => {
    refreshMineBalance();
    const interval = setInterval(refreshMineBalance, 15_000);
    return () => clearInterval(interval);
  }, [refreshMineBalance]);

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
      const balanceBefore = mineBalance ?? 0;
      const balanceAfter = await refreshMineBalance();
      const mineEarned = balanceAfter !== null ? Math.max(0, balanceAfter - balanceBefore) : 0;
      setLastResult({ type: "win", payout: currentPayout, multiplier: currentMultiplier, mineEarned });
      revealFullLayout(roundId);
    } catch (err: any) {
      setError(`Cash out failed: ${err.message ?? err}`);
      appendLog(`cash_out failed: ${err.message ?? err}`);
    } finally {
      setBusy(false);
    }
  }, [program, wallet.publicKey, roundId, currentMultiplier, currentPayout, appendLog, refreshMineBalance, mineBalance, revealFullLayout]);

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
          setLastResult({ type: "lose", lost: Number(betAmount) });
          revealFullLayout(roundId);
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
  }, [program, roundId, status, appendLog, pendingSince, betAmount, revealFullLayout]);

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
        <div className="header-right">
          {wallet.publicKey && mineBalance !== null && (
            <span className="mine-balance" title="Earned by cashing out with 3+ safe tiles revealed">
              {mineBalance.toFixed(2)} $MINE
            </span>
          )}
          <WalletMultiButton />
        </div>
      </header>

      <p className="rules">
        Grid of {TOTAL_TILES} tiles, some hidden as mines. Reveal tiles one at a time — each safe one raises your
        payout multiplier. Cash out any time, or lose the bet if you hit a mine. More mines chosen = higher
        multiplier per tile, but a shorter safe streak.
      </p>

      <div className="panel">
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
          </label>

          <div className="mult-preview" key={mineCount} style={{ "--mult-color": riskColor(mineCount) } as any}>
            <span className="mult-value">
              {(fairMultiplier(1, mineCount) * (1 - HOUSE_EDGE_BPS / 10_000)).toFixed(2)}x
            </span>
            <span className="mult-caption">first safe tile pays</span>
          </div>

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
      </div>

      {lastResult && <ResultBanner result={lastResult} />}

      {playedMineCount !== null && (
        <p className="played-mines-label">
          This board was played with <strong>{playedMineCount}</strong> mines
          {playedMineCount !== mineCount && status !== "active"
            ? ` (the "Mines" field above is already set for your next round)`
            : ""}
        </p>
      )}

      <div className="grid" style={{ gridTemplateColumns: `repeat(${GRID_SIZE}, 1fr)` }}>
        {tiles.map((t, i) => (
          <button
            key={i}
            className={`tile ${t}${stuckTiles.has(i) ? " stuck" : ""}`}
            disabled={busy || status !== "active" || t !== "hidden"}
            onClick={() => revealTile(i)}
            title={
              t === "pending"
                ? "waiting for resolver..."
                : t === "safe-unclicked"
                  ? "was safe — you didn't click it"
                  : t === "mine-unclicked"
                    ? "was a mine"
                    : undefined
            }
          >
            {t === "safe" || t === "safe-unclicked"
              ? "💎"
              : t === "mine" || t === "mine-unclicked"
                ? "💥"
                : t === "pending"
                  ? stuckTiles.has(i) ? "!" : "…"
                  : ""}
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

const CONFETTI_COLORS = ["#fbbf24", "#8b5cf6", "#34d399", "#fde68a", "#f472b6"];

function ResultBanner({ result }: { result: RoundResult }) {
  if (result.type === "win") {
    const confettiPieces = Array.from({ length: 24 }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.3,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    }));
    return (
      <div className="result-banner win" key={`win-${result.payout}`}>
        <div className="confetti">
          {confettiPieces.map((p, i) => (
            <span
              key={i}
              style={{ left: `${p.left}%`, animationDelay: `${p.delay}s`, background: p.color }}
            />
          ))}
        </div>
        <div className="result-headline">You cashed out</div>
        <div className="result-amount">+{result.payout.toFixed(4)} XNT</div>
        <div className="result-sub">at {result.multiplier.toFixed(3)}x multiplier</div>
        {result.mineEarned > 0 && (
          <div className="result-mine">+{result.mineEarned.toFixed(2)} $MINE earned</div>
        )}
      </div>
    );
  }
  return (
    <div className="result-banner lose" key={`lose-${result.lost}`}>
      <div className="result-headline">Boom — hit a mine</div>
      <div className="result-amount">-{result.lost.toFixed(4)} XNT</div>
      <div className="result-sub">Start a new round to try again.</div>
    </div>
  );
}
