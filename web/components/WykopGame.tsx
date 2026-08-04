"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN, type Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  PROGRAM_ID,
  DIG_TIER_LABELS,
  configPda,
  vaultPda,
  digConfigPda,
  digSessionPda,
  stakingPoolPda,
  rewardVaultPda,
  poolXntVaultPda,
  poolMineVaultPda,
} from "@/lib/config";
import idl from "@/lib/idl/mines.json";

type Status = "idle" | "digging" | "resolving" | "revealing" | "done";
type RarityInfo = { rewardBps: number; baseChanceBps: number; durationScaling: number[] };
type DigResult = { rarityHit: number; mineEarned: number } | null;
type Particle = { id: number; left: number; emoji: string; big: boolean };
type Popup = { id: number; amount: number };

const STRIKE_MS = 4000;

/** Splits `total` into `n` positive, deliberately UNEVEN chunks that sum to
 * `total` — each pickaxe strike lands a different-sized chunk instead of a
 * smooth linear drip, per the "1 strike = 1 uneven chunk" request. */
function unevenSplit(total: number, n: number): number[] {
  if (n <= 0) return [];
  if (total <= 0) return Array.from({ length: n }, () => 0);
  const weights = Array.from({ length: n }, () => 0.25 + Math.random());
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (w / sum) * total);
}

const RARITY_NAMES = ["Rare", "Epic", "Legendary", "Mythic", "Tier 5", "Tier 6", "Tier 7", "Tier 8"];
const RARITY_COLORS = ["#60a5fa", "#c084fc", "#fbbf24", "#f472b6"];
// How many recent sessions to scan on mount looking for one this wallet
// still has open — see resumeActiveSession below.
const RESUME_SCAN_WINDOW = 15;

function effectiveChancePct(tier: RarityInfo, durationTier: number): number {
  const scaling = tier.durationScaling[durationTier] ?? 0;
  return (tier.baseChanceBps * scaling) / 10_000 / 100;
}

export function WykopGame() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [durationTier, setDurationTier] = useState(0);
  const [digConfigData, setDigConfigData] = useState<any>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [sessionId, setSessionId] = useState<bigint | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [crystalsShown, setCrystalsShown] = useState(0);
  const [floorEstimate, setFloorEstimate] = useState(0);
  const [particles, setParticles] = useState<Particle[]>([]);
  const [popups, setPopups] = useState<Popup[]>([]);
  const [strikeKey, setStrikeKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mineBalance, setMineBalance] = useState<number | null>(null);
  const [result, setResult] = useState<DigResult>(null);
  const [resuming, setResuming] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const strikeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const particleIdRef = useRef(0);
  const popupIdRef = useRef(0);

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

  const refreshDigConfig = useCallback(async () => {
    if (!program) return null;
    try {
      const [digConfig] = digConfigPda();
      const data = await (program.account as any).digConfig.fetch(digConfig);
      setDigConfigData(data);
      return data;
    } catch {
      return null;
    }
  }, [program]);

  useEffect(() => {
    refreshDigConfig();
  }, [refreshDigConfig]);

  const refreshMineBalance = useCallback(
    async (mineMint?: PublicKey): Promise<number> => {
      const mint = mineMint ?? digConfigData?.mineMint;
      if (!wallet.publicKey || !mint) return 0;
      try {
        const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
        const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
        const info = await connection.getTokenAccountBalance(ata).catch(() => null);
        const value = info ? info.value.uiAmount ?? 0 : 0;
        setMineBalance(value);
        return value;
      } catch {
        return 0;
      }
    },
    [wallet.publicKey, connection, digConfigData],
  );

  useEffect(() => {
    refreshMineBalance();
    const interval = setInterval(() => refreshMineBalance(), 15_000);
    return () => clearInterval(interval);
  }, [refreshMineBalance]);

  // Switching away to another tab (Mines/Stake) and back used to reset this
  // component entirely — the on-chain dig session (and the XNT already
  // paid for it) was never actually lost, but the UI had no way to find it
  // again. On mount, scan this wallet's most recent sessions for one still
  // Active and pick up tracking it instead of silently starting from idle.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setResuming(true);
      try {
        if (!program || !wallet.publicKey) return;
        const cfg = digConfigData ?? (await refreshDigConfig());
        if (!cfg) return;

        const total = BigInt(cfg.totalSessions.toString());
        const start = total > BigInt(RESUME_SCAN_WINDOW) ? total - BigInt(RESUME_SCAN_WINDOW) : 0n;
        for (let id = total - 1n; id >= start && id >= 0n; id--) {
          const [session] = digSessionPda(id);
          const acc: any = await (program.account as any).digSession.fetch(session).catch(() => null);
          if (!acc) continue;
          if (acc.status !== 0) continue; // not Active
          if (!acc.player.equals(wallet.publicKey)) continue;

          if (cancelled) return;
          const duration = cfg.tierDurations[acc.durationTier];
          const elapsed = Math.floor(Date.now() / 1000) - Number(acc.startTs);
          const betAmount = BigInt(cfg.tierPrices[acc.durationTier].toString());
          const floor = await fetchFloorEstimate(program, connection, betAmount);
          if (cancelled) return;
          setSessionId(id);
          setDurationTier(acc.durationTier);
          setTotalDuration(duration);
          setFloorEstimate(floor);
          if (elapsed >= duration) {
            setSecondsLeft(0);
            setCrystalsShown(floor);
            setStatus("resolving");
          } else {
            setSecondsLeft(duration - elapsed);
            setStatus("digging");
          }
          return;
        }
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only re-run when the wallet/program identity actually changes — not
    // on every digConfigData refresh, which would fight with local ticking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program, wallet.publicKey]);

  const startDig = useCallback(async () => {
    if (!program || !wallet.publicKey || !digConfigData) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const [config] = configPda();
      const [digConfig] = digConfigPda();
      const [vault] = vaultPda();
      const [stakingPool] = stakingPoolPda();
      const [rewardVault] = rewardVaultPda();
      const newSessionId: bigint = BigInt(digConfigData.totalSessions.toString());
      const [session] = digSessionPda(newSessionId);
      const clientSeed = Array.from(crypto.getRandomValues(new Uint8Array(32)));

      const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import(
        "@solana/spl-token"
      );
      const playerMineAta = getAssociatedTokenAddressSync(digConfigData.mineMint, wallet.publicKey);

      await program.methods
        .startDig(durationTier, clientSeed)
        .accounts({
          player: wallet.publicKey,
          config,
          digConfig,
          vault,
          session,
          mineMint: digConfigData.mineMint,
          playerMineAta,
          stakingPool,
          rewardVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setSessionId(newSessionId);
      const duration = digConfigData.tierDurations[durationTier];
      const betAmount = BigInt(digConfigData.tierPrices[durationTier].toString());
      const floor = await fetchFloorEstimate(program, connection, betAmount);
      setFloorEstimate(floor);
      setSecondsLeft(duration);
      setTotalDuration(duration);
      setCrystalsShown(0);
      setParticles([]);
      setStatus("digging");
      await refreshDigConfig();
    } catch (err: any) {
      setError(`Could not start dig: ${err.message ?? err}`);
    } finally {
      setBusy(false);
    }
  }, [program, wallet.publicKey, digConfigData, durationTier, refreshDigConfig]);

  // Cosmetic 1s countdown, decoupled from the strike cadence below — purely
  // client-side, no on-chain state per tick. Ends the dig at zero.
  useEffect(() => {
    if (status !== "digging" || totalDuration <= 0) return;
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          setStatus("resolving");
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [status, totalDuration]);

  // Pickaxe strikes every STRIKE_MS — one strike = one uneven chunk of the
  // estimated floor landing at once (per the "1 kopnięcie = 1 naliczenie,
  // zawsze nierównomiernej" request), instead of a smooth linear drip. The
  // single real settlement still only happens once, when the countdown
  // above hits zero (see the resolving effect below) — this is purely a
  // cosmetic "does it feel like mining" pass.
  useEffect(() => {
    if (status !== "digging" || !digConfigData || totalDuration <= 0) return;
    const remainingTicks = Math.max(1, Math.round((secondsLeft * 1000) / STRIKE_MS));
    const remainingTotal = Math.max(0, floorEstimate - crystalsShown);
    const increments = unevenSplit(remainingTotal, remainingTicks);
    let tickIndex = 0;

    strikeTimerRef.current = setInterval(() => {
      const amount = increments[tickIndex] ?? 0;
      tickIndex++;

      setCrystalsShown((prev) => Math.min(floorEstimate, prev + amount));
      setStrikeKey((k) => k + 1);
      setPopups((prev) => [...prev.slice(-3), { id: popupIdRef.current++, amount }]);

      const burstSize = 5 + Math.floor(Math.random() * 3);
      const burst: Particle[] = Array.from({ length: burstSize }, () => ({
        id: particleIdRef.current++,
        left: 20 + Math.random() * 60,
        emoji: Math.random() < 0.55 ? "💎" : "✨",
        big: Math.random() < 0.35,
      }));
      setParticles((prev) => [...prev.slice(-16), ...burst]);

      if (tickIndex >= increments.length) {
        if (strikeTimerRef.current) clearInterval(strikeTimerRef.current);
      }
    }, STRIKE_MS);

    return () => {
      if (strikeTimerRef.current) clearInterval(strikeTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, totalDuration]);

  // Fire the real settlement once cosmetic countdown finishes.
  useEffect(() => {
    if (status !== "resolving" || sessionId === null || !program) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/dig-reveal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionId.toString() }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `resolver returned ${res.status}`);
        }

        // Poll the session account until the resolver's tx lands.
        const [session] = digSessionPda(sessionId);
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 1200));
          const sessionAccount: any = await (program.account as any).digSession.fetch(session);
          if (sessionAccount.status === 1) {
            if (cancelled) return;
            const balanceBefore = mineBalance ?? 0;
            const balanceAfter = await refreshMineBalance(digConfigData?.mineMint);
            setResult({
              rarityHit: sessionAccount.rarityHit,
              mineEarned: Math.max(0, balanceAfter - balanceBefore),
            });
            // Play the reveal (flash/gem/+amount) as one last big strike in
            // the mine scene itself, instead of jumping straight to a flat
            // end screen — this is the actual win moment, so it needs to
            // happen where the player is looking, not after it.
            setStatus("revealing");
            await new Promise((r) => setTimeout(r, 2300));
            if (cancelled) return;
            setStatus("done");
            return;
          }
        }
        throw new Error("resolver didn't settle in time");
      } catch (err: any) {
        if (!cancelled) setError(`Dig settlement failed: ${err.message ?? err}`);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, sessionId]);

  const rarityTiers: RarityInfo[] = digConfigData
    ? digConfigData.rarityTiers.slice(0, digConfigData.activeRarityCount)
    : [];

  return (
    <div className="mines-app">
      <header>
        <h1 className="wykop-title">Wykop</h1>
        <div className="header-right">
          {wallet.publicKey && mineBalance !== null && (
            <span className="mine-balance">{mineBalance.toFixed(2)} $MINE</span>
          )}
          <WalletMultiButton />
        </div>
      </header>

      <p className="rules">
        Rent a mine for a fixed time. Common crystals drip in guaranteed the whole time — cash them out as $MINE when
        the timer ends. Longer digs also get a genuinely better shot at Rare/Epic bonus finds, not just more time.
      </p>

      {resuming && status === "idle" && <p className="status-banner">Checking for an in-progress dig...</p>}

      {!resuming && status === "idle" && digConfigData && (
        <div className="panel">
          <div className="tier-picker">
            {DIG_TIER_LABELS.map((label, i) => (
              <button
                key={i}
                className={`tier-option${durationTier === i ? " selected" : ""}`}
                onClick={() => setDurationTier(i)}
                disabled={busy}
              >
                <span className="tier-duration">{label}</span>
                <span className="tier-price">{(Number(digConfigData.tierPrices[i]) / 1e9).toFixed(2)} XNT</span>
              </button>
            ))}
          </div>

          <div className="odds-preview">
            {rarityTiers.map((tier, i) => (
              <div key={i} className="odds-row">
                <span className="odds-name" style={{ color: RARITY_COLORS[i % RARITY_COLORS.length] }}>
                  {RARITY_NAMES[i] ?? `Tier ${i}`}
                </span>
                <span className="odds-chance">{effectiveChancePct(tier, durationTier).toFixed(1)}% chance</span>
                <span className="odds-reward">+{(tier.rewardBps / 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>

          <button className="start-dig-btn" onClick={startDig} disabled={busy || !program}>
            Start Dig
          </button>
        </div>
      )}

      {(status === "digging" || status === "resolving" || status === "revealing") && digConfigData && (
        <div className="panel dig-active">
          <div className="dig-timer">
            {status === "digging" ? `${secondsLeft}s` : status === "resolving" ? "Final strike..." : ""}
          </div>

          <div className={`mine-scene${status === "resolving" ? " charging" : ""}`}>
            <div className="crystal-stream">
              {particles.map((p) => (
                <span
                  key={p.id}
                  className={`crystal-particle${p.big ? " big" : ""}`}
                  style={{ left: `${p.left}%` }}
                >
                  {p.emoji}
                </span>
              ))}
            </div>

            {status !== "revealing" && (
              <>
                <span className={`mine-rock hit`} key={strikeKey}>
                  🪨
                </span>
                <span className="pickaxe">⛏️</span>
                {popups.map((p) => (
                  <span
                    key={p.id}
                    className="strike-popup"
                    style={{ left: `${30 + Math.random() * 40}%` }}
                  >
                    +{p.amount.toFixed(1)}
                  </span>
                ))}
              </>
            )}

            {status === "revealing" && result && (
              <div className="reveal-overlay">
                <div className={`reveal-flash${result.rarityHit === 0xff ? " common" : ""}`} />
                {result.rarityHit !== 0xff && (
                  <div className="confetti">
                    {Array.from({ length: 30 }, (_, i) => (
                      <span
                        key={i}
                        style={{
                          left: `${Math.random() * 100}%`,
                          animationDelay: `${Math.random() * 0.3}s`,
                          background: RARITY_COLORS[result.rarityHit % RARITY_COLORS.length],
                        }}
                      />
                    ))}
                  </div>
                )}
                <div
                  className="reveal-gem"
                  style={
                    result.rarityHit !== 0xff
                      ? { filter: `drop-shadow(0 0 24px ${RARITY_COLORS[result.rarityHit % RARITY_COLORS.length]})` }
                      : undefined
                  }
                >
                  💎
                </div>
                {result.rarityHit !== 0xff && (
                  <div
                    className="reveal-rarity"
                    style={{ color: RARITY_COLORS[result.rarityHit % RARITY_COLORS.length] }}
                  >
                    {RARITY_NAMES[result.rarityHit] ?? "Bonus"} find!
                  </div>
                )}
                <div className="reveal-text">+{result.mineEarned.toFixed(2)} $MINE</div>
              </div>
            )}
          </div>

          {status !== "revealing" && (
            <div className="crystal-counter" key={Math.floor(crystalsShown * 10)}>
              <span className="crystal-icon">💎</span>
              {crystalsShown.toFixed(1)} $MINE
            </div>
          )}
          {status === "digging" && (
            <div className="dig-progress-track">
              <div
                className="dig-progress-fill"
                style={{
                  width: `${totalDuration > 0 ? ((totalDuration - secondsLeft) / totalDuration) * 100 : 0}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {status === "done" && result && (
        <div className={`result-banner ${result.rarityHit === 0xff ? "win" : "win jackpot"}`}>
          <div className="result-headline">
            {result.rarityHit === 0xff ? "Dig complete" : `${RARITY_NAMES[result.rarityHit] ?? "Bonus"} find!`}
          </div>
          <div className="result-amount">+{result.mineEarned.toFixed(2)} $MINE</div>
          <button
            className="start-dig-btn"
            style={{ marginTop: 16 }}
            onClick={() => {
              setStatus("idle");
              setResult(null);
              setSessionId(null);
            }}
          >
            Dig again
          </button>
        </div>
      )}

      {error && <p className="error-banner">{error}</p>}
      {!digConfigData && <p className="status-banner">Loading dig configuration...</p>}
    </div>
  );
}

// Mirrors VOLUME_THRESHOLDS / EMISSION_SCALE in programs/mines/src/lib.rs —
// keep in sync if the on-chain schedule changes.
const EMISSION_SCALE = 1_000_000n;
const LAMPORTS_PER_XNT = 1_000_000_000n;
const VOLUME_THRESHOLDS: [bigint, bigint][] = [
  [1_000_000n * LAMPORTS_PER_XNT, 1_000_000n],
  [5_000_000n * LAMPORTS_PER_XNT, 500_000n],
  [20_000_000n * LAMPORTS_PER_XNT, 250_000n],
  [80_000_000n * LAMPORTS_PER_XNT, 125_000n],
  [(1n << 64n) - 1n, 62_500n],
];

function emissionRateScaled(cumulativeVolume: bigint): bigint {
  for (const [threshold, rate] of VOLUME_THRESHOLDS) {
    if (cumulativeVolume < threshold) return rate;
  }
  return VOLUME_THRESHOLDS[VOLUME_THRESHOLDS.length - 1][1];
}

/**
 * Client-side mirror of resolve_dig's price-aware floor formula in
 * programs/mines/src/lib.rs — fetches the same live inputs (cumulative
 * volume, pool reserves) the program reads, so the cosmetic counter tracks
 * what resolve_dig will actually mint instead of an unrelated placeholder.
 * Falls back to 0 on any fetch failure (animation-only, never blocks play).
 */
async function fetchFloorEstimate(program: any, connection: any, betAmountLamports: bigint): Promise<number> {
  try {
    const [config] = configPda();
    const configData: any = await program.account.config.fetch(config);
    const cumulativeVolume = BigInt(configData.cumulativeVolume.toString());
    const rate = emissionRateScaled(cumulativeVolume);
    const targetXntValue = (betAmountLamports * rate) / EMISSION_SCALE;

    const [poolXntVault] = poolXntVaultPda();
    const [poolMineVault] = poolMineVaultPda();
    const xntVaultInfo = await connection.getAccountInfo(poolXntVault);
    const reserveXnt = xntVaultInfo ? BigInt(xntVaultInfo.lamports) : 0n;
    const mineVaultBalance = await connection.getTokenAccountBalance(poolMineVault).catch(() => null);
    const reserveMine = mineVaultBalance ? BigInt(mineVaultBalance.value.amount) : 0n;

    const floorRaw =
      reserveXnt > 0n && reserveMine > 0n ? (targetXntValue * reserveMine) / reserveXnt : targetXntValue;
    return Number(floorRaw) / 1e6;
  } catch {
    return 0;
  }
}
