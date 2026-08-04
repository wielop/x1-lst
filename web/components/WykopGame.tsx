"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN, type Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { PROGRAM_ID, DIG_TIER_LABELS, configPda, vaultPda, digConfigPda, digSessionPda } from "@/lib/config";
import idl from "@/lib/idl/mines.json";

type Status = "idle" | "digging" | "resolving" | "done";
type RarityInfo = { rewardBps: number; baseChanceBps: number; durationScaling: number[] };
type DigResult = { rarityHit: number; mineEarned: number } | null;

const RARITY_NAMES = ["Rare", "Epic", "Legendary", "Mythic", "Tier 5", "Tier 6", "Tier 7", "Tier 8"];
const RARITY_COLORS = ["#60a5fa", "#c084fc", "#fbbf24", "#f472b6"];

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
  const [crystalsShown, setCrystalsShown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mineBalance, setMineBalance] = useState<number | null>(null);
  const [result, setResult] = useState<DigResult>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    if (!program) return;
    try {
      const [digConfig] = digConfigPda();
      const data = await (program.account as any).digConfig.fetch(digConfig);
      setDigConfigData(data);
    } catch {
      // not initialized yet, or RPC hiccup
    }
  }, [program]);

  useEffect(() => {
    refreshDigConfig();
  }, [refreshDigConfig]);

  const refreshMineBalance = useCallback(async () => {
    if (!program || !wallet.publicKey || !digConfigData) return;
    try {
      const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
      const ata = getAssociatedTokenAddressSync(digConfigData.mineMint, wallet.publicKey);
      const info = await connection.getTokenAccountBalance(ata).catch(() => null);
      setMineBalance(info ? info.value.uiAmount ?? 0 : 0);
    } catch {
      // ignore
    }
  }, [program, wallet.publicKey, connection, digConfigData]);

  useEffect(() => {
    refreshMineBalance();
    const interval = setInterval(refreshMineBalance, 15_000);
    return () => clearInterval(interval);
  }, [refreshMineBalance]);

  const startDig = useCallback(async () => {
    if (!program || !wallet.publicKey || !digConfigData) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const [config] = configPda();
      const [digConfig] = digConfigPda();
      const [vault] = vaultPda();
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
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setSessionId(newSessionId);
      const duration = digConfigData.tierDurations[durationTier];
      setSecondsLeft(duration);
      setCrystalsShown(0);
      setStatus("digging");
      await refreshDigConfig();
    } catch (err: any) {
      setError(`Could not start dig: ${err.message ?? err}`);
    } finally {
      setBusy(false);
    }
  }, [program, wallet.publicKey, digConfigData, durationTier, refreshDigConfig]);

  // Cosmetic countdown + crystal-drip animation — purely client-side, no
  // on-chain state per tick. The single real settlement happens once, when
  // the timer hits zero (see the effect below).
  useEffect(() => {
    if (status !== "digging" || !digConfigData) return;
    const duration = digConfigData.tierDurations[durationTier];
    const floorEstimate = estimateFloor(digConfigData, durationTier);
    const tickMs = 400;
    const totalTicks = Math.max(1, Math.floor((duration * 1000) / tickMs));
    let tick = 0;

    timerRef.current = setInterval(() => {
      tick++;
      setSecondsLeft(Math.max(0, duration - Math.floor((tick * tickMs) / 1000)));
      setCrystalsShown(Math.min(floorEstimate, (floorEstimate * tick) / totalTicks));
      if (tick >= totalTicks) {
        if (timerRef.current) clearInterval(timerRef.current);
        setStatus("resolving");
      }
    }, tickMs);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

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
            const balanceAfter = await refreshMineBalanceAndReturn();
            setResult({
              rarityHit: sessionAccount.rarityHit,
              mineEarned: Math.max(0, balanceAfter - balanceBefore),
            });
            setStatus("done");
            return;
          }
        }
        throw new Error("resolver didn't settle in time");
      } catch (err: any) {
        if (!cancelled) setError(`Dig settlement failed: ${err.message ?? err}`);
      }
    })();

    async function refreshMineBalanceAndReturn(): Promise<number> {
      if (!digConfigData || !wallet.publicKey) return 0;
      const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
      const ata = getAssociatedTokenAddressSync(digConfigData.mineMint, wallet.publicKey);
      const info = await connection.getTokenAccountBalance(ata).catch(() => null);
      const value = info ? info.value.uiAmount ?? 0 : 0;
      setMineBalance(value);
      return value;
    }

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

      {status === "idle" && digConfigData && (
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

      {(status === "digging" || status === "resolving") && digConfigData && (
        <div className="panel dig-active">
          <div className="dig-timer">{status === "digging" ? `${secondsLeft}s` : "Settling..."}</div>
          <div className="crystal-counter">
            <span className="crystal-icon">💎</span>
            {crystalsShown.toFixed(1)} $MINE
          </div>
          <div className="dig-progress-track">
            <div
              className="dig-progress-fill"
              style={{
                width: `${
                  digConfigData
                    ? ((digConfigData.tierDurations[durationTier] - secondsLeft) /
                        digConfigData.tierDurations[durationTier]) *
                      100
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {status === "done" && result && (
        <div className={`result-banner ${result.rarityHit === 0xff ? "win" : "win jackpot"}`}>
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

/** Client-side mirror of the on-chain floor formula, for the cosmetic animation only. */
function estimateFloor(digConfigData: any, durationTier: number): number {
  const price = Number(digConfigData.tierPrices[durationTier]);
  // Emission rate isn't known client-side without fetching Config too; the
  // animation uses a conservative flat estimate (rate=1.0) since it's purely
  // cosmetic — the real amount is whatever resolve_dig actually mints.
  return price / 1e6;
}
