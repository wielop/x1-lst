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
  liquidityPoolPda,
  poolAuthorityPda,
} from "@/lib/config";
import idl from "@/lib/idl/mines.json";

type SessionStatus = "digging" | "resolving" | "revealing" | "done" | "error";
type RarityInfo = { rewardBps: number; baseChanceBps: number; durationScaling: number[] };
type DigResult = { rarityHit: number; mineEarned: number } | null;
type Particle = { id: number; left: number; emoji: string; big: boolean };
type Popup = { id: number; amount: number };

type DigSessionState = {
  sessionId: bigint;
  durationTier: number;
  status: SessionStatus;
  startTs: number; // ms epoch
  totalDuration: number; // seconds
  floorEstimate: number;
  crystalsShown: number;
  strikeIncrements: number[];
  strikeIndex: number;
  nextStrikeAt: number; // ms epoch
  particles: Particle[];
  popups: Popup[];
  strikeKey: number;
  result: DigResult;
  revealUntil: number; // ms epoch, valid once status === "revealing"
  error: string | null;
  expanded: boolean;
};

const STRIKE_MS = 4000;
const REVEAL_MS = 2300;
const TICK_MS = 250;

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
// How many recent (globally-numbered) sessions to scan on mount looking for
// ones this wallet still has open — see the resume effect below. Session
// ids are global across all players, not per-wallet, so this is a
// best-effort window, same limitation the single-session version had.
const RESUME_SCAN_WINDOW = 30;

let particleIdCounter = 0;
let popupIdCounter = 0;

function effectiveChancePct(tier: RarityInfo, durationTier: number): number {
  const scaling = tier.durationScaling[durationTier] ?? 0;
  return (tier.baseChanceBps * scaling) / 10_000 / 100;
}

/** A fleshed-out illustrated miner (helmet, shirt, overalls, boots) —
 * replaces the old bare-wireframe stick figure, which read as a lifeless
 * blob on its own. Keeps the exact same swing-arm skeleton and
 * `pickaxeSwing` keyframe as the stick-figure version (shoulder pivot,
 * arm path, emoji pickaxe) since that geometry was fiddly to get right
 * the first time — only the body around it is new. Layering order
 * matters here: the helmet is a full ellipse painted *behind* the head
 * circle, so the head circle's fill covers its lower half and only the
 * dome peeks out above, like a hard hat actually sitting on a head. */
function MinerFigure({ struck }: { struck: boolean }) {
  return (
    <svg viewBox="0 0 140 150" className="miner-figure" aria-hidden="true">
      <ellipse cx="58" cy="141" rx="38" ry="6" className="miner-shadow" />

      {/* legs + boots */}
      <path d="M 55 96 L 40 138" className="miner-leg" />
      <path d="M 55 96 L 72 138" className="miner-leg" />
      <ellipse cx="40" cy="140" rx="9" ry="5" className="miner-boot" />
      <ellipse cx="72" cy="140" rx="9" ry="5" className="miner-boot" />

      {/* torso (shirt) */}
      <rect x="39" y="46" width="32" height="50" rx="12" className="miner-torso" />

      {/* static (near-side) arm */}
      <path d="M 42 54 L 25 80" className="miner-arm-static" />
      <circle cx="25" cy="82" r="6" className="miner-hand" />

      {/* head + hard hat */}
      <ellipse cx="55" cy="26" rx="18" ry="15" className="miner-helmet" />
      <circle cx="55" cy="34" r="15" className="miner-head" />
      <rect x="36" y="26" width="38" height="5" rx="2.5" className="miner-helmet-brim" />
      <circle cx="63" cy="22" r="3" className="miner-lamp" />

      {/* swinging arm + pickaxe */}
      <g className={`miner-swing-arm${struck ? " struck" : ""}`}>
        <path d="M 70 54 L 100 40" className="miner-arm-swing" />
        <circle cx="100" cy="40" r="6" className="miner-hand" />
        <text x="108" y="36" className="pickaxe-emoji" transform="rotate(-20 108 36)">
          ⛏️
        </text>
      </g>
    </svg>
  );
}

function buildSessionState(
  sessionId: bigint,
  durationTier: number,
  totalDuration: number,
  startTs: number,
  floorEstimate: number,
  expanded: boolean,
): DigSessionState {
  const now = Date.now();
  const elapsedMs = Math.max(0, now - startTs);
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const pastDuration = totalDuration > 0 && elapsedSec >= totalDuration;

  const initialShown = pastDuration
    ? floorEstimate
    : totalDuration > 0
      ? Math.min(floorEstimate, (floorEstimate * elapsedSec) / totalDuration)
      : 0;

  const totalTicks = Math.max(1, Math.round((totalDuration * 1000) / STRIKE_MS));
  const ticksElapsed = Math.min(totalTicks, Math.floor(elapsedMs / STRIKE_MS));
  const remainingTicks = Math.max(0, totalTicks - ticksElapsed);
  const remainingTotal = Math.max(0, floorEstimate - initialShown);
  const strikeIncrements = pastDuration ? [] : unevenSplit(remainingTotal, Math.max(1, remainingTicks));

  return {
    sessionId,
    durationTier,
    status: pastDuration ? "resolving" : "digging",
    startTs,
    totalDuration,
    floorEstimate,
    crystalsShown: initialShown,
    strikeIncrements,
    strikeIndex: 0,
    nextStrikeAt: now + STRIKE_MS,
    particles: [],
    popups: [],
    strikeKey: 0,
    result: null,
    revealUntil: 0,
    error: null,
    expanded,
  };
}

export function WykopGame() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [durationTier, setDurationTier] = useState(0);
  const [digConfigData, setDigConfigData] = useState<any>(null);
  const [sessions, setSessions] = useState<Record<string, DigSessionState>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mineBalance, setMineBalance] = useState<number | null>(null);
  const [resuming, setResuming] = useState(true);
  const resolvingRef = useRef<Set<string>>(new Set());

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
  // component entirely — on-chain dig sessions (and the XNT already paid
  // for them) were never actually lost, but the UI had no way to find them
  // again. On mount, scan this wallet's most recent sessions for ALL still
  // Active ones and pick up tracking every one of them — a player can run
  // several digs at once, so this no longer stops at the first match.
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
        const found: DigSessionState[] = [];
        for (let id = total - 1n; id >= start && id >= 0n; id--) {
          const [session] = digSessionPda(id);
          const acc: any = await (program.account as any).digSession.fetch(session).catch(() => null);
          if (!acc) continue;
          if (acc.status !== 0) continue; // not Active
          if (!acc.player.equals(wallet.publicKey)) continue;

          const duration = cfg.tierDurations[acc.durationTier];
          const betAmount = BigInt(cfg.tierPrices[acc.durationTier].toString());
          const floor = await fetchFloorEstimate(program, connection, betAmount);
          if (cancelled) return;
          found.push(buildSessionState(id, acc.durationTier, duration, Number(acc.startTs) * 1000, floor, false));
        }
        if (cancelled) return;
        if (found.length > 0) {
          found[0].expanded = true;
          setSessions((prev) => {
            const next = { ...prev };
            for (const s of found) next[s.sessionId.toString()] = s;
            return next;
          });
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
    try {
      const [config] = configPda();
      const [digConfig] = digConfigPda();
      const [vault] = vaultPda();
      const [stakingPool] = stakingPoolPda();
      const [rewardVault] = rewardVaultPda();
      const [liquidityPool] = liquidityPoolPda();
      const [poolXntVault] = poolXntVaultPda();
      const [poolMineVault] = poolMineVaultPda();
      const [poolAuthority] = poolAuthorityPda();
      const clientSeed = Array.from(crypto.getRandomValues(new Uint8Array(32)));

      const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import(
        "@solana/spl-token"
      );
      const playerMineAta = getAssociatedTokenAddressSync(digConfigData.mineMint, wallet.publicKey);

      // Same plain-language balance guard as MinesGame's startRound — catch
      // "can't actually afford this" client-side instead of surfacing a raw
      // "insufficient funds for rent" simulation error. Found via the
      // swarm load test.
      const priceLamports = Number(digConfigData.tierPrices[durationTier].toString());
      const FEE_RESERVE_LAMPORTS = 5_000_000; // 0.005 XNT
      const walletBalance = await connection.getBalance(wallet.publicKey);
      if (priceLamports + FEE_RESERVE_LAMPORTS > walletBalance) {
        throw new Error(
          `Not enough XNT: this tier costs ${(priceLamports / 1e9).toFixed(3)}, you have ${(walletBalance / 1e9).toFixed(4)} (need a little extra for fees).`,
        );
      }

      // `session`'s PDA is seeded with dig_config.total_sessions read LIVE
      // on-chain at instruction-execution time (see StartDig in lib.rs).
      // `digConfigData` here is React state that can be seconds stale (it's
      // only refreshed periodically), so relying on it alone for the id is
      // an even wider race window than it looks — another wallet's
      // start_dig landing in between means our precomputed session address
      // no longer matches what the program now expects: AnchorError
      // ConstraintSeeds (2006). Nothing was spent (the whole instruction
      // reverts), so re-fetch the live counter and retry. Surfaced under
      // the swarm load test as a real concurrency bug real simultaneous
      // players would also hit.
      let newSessionId: bigint;
      for (let attempt = 0; ; attempt++) {
        const freshDigConfig = attempt === 0 ? digConfigData : await refreshDigConfig();
        if (!freshDigConfig) throw new Error("dig config unavailable");
        newSessionId = BigInt(freshDigConfig.totalSessions.toString());
        const [session] = digSessionPda(newSessionId);
        try {
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
              poolXntVault,
              poolMineVault,
              liquidityPool,
              poolAuthority,
              tokenProgram: TOKEN_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .rpc();
          break;
        } catch (err: any) {
          const isSeedsRace = String(err.message ?? err).includes("ConstraintSeeds") || String(err.message ?? err).includes("2006");
          // 5 immediate-retry attempts (no delay) turned out to not be enough
          // under sustained heavy concurrent load (observed live: a swarm
          // load test hammering start_dig repeatedly could out-race a
          // player's own click every single attempt). More attempts plus a
          // small random stagger before each retry — so competing clients
          // aren't all retrying in lockstep against the same fresh counter
          // read — makes eventually winning the race far more likely
          // without the player having to manually click "try again".
          if (!isSeedsRace || attempt >= 12) throw err;
          await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
        }
      }

      const duration = digConfigData.tierDurations[durationTier];
      const betAmount = BigInt(digConfigData.tierPrices[durationTier].toString());
      const floor = await fetchFloorEstimate(program, connection, betAmount);
      const fresh = buildSessionState(newSessionId, durationTier, duration, Date.now(), floor, true);
      setSessions((prev) => {
        // Collapse older rows so the new dig is the one in focus; leave
        // "done" ones as the player left them.
        const next: Record<string, DigSessionState> = {};
        for (const [k, v] of Object.entries(prev)) next[k] = v.expanded && v.status !== "done" ? { ...v, expanded: false } : v;
        next[newSessionId.toString()] = fresh;
        return next;
      });
      await refreshDigConfig();
    } catch (err: any) {
      setError(`Could not start dig: ${err.message ?? err}`);
    } finally {
      setBusy(false);
    }
  }, [program, wallet.publicKey, digConfigData, durationTier, refreshDigConfig, connection]);

  // Single global tick drives every tracked session at once, purely from
  // absolute timestamps (startTs / nextStrikeAt / revealUntil) rather than
  // per-session effects that start/stop on status changes — that pattern
  // is what caused an earlier bug where changing status mid-flight
  // cancelled the very effect driving that change. Time-based ticking
  // sidesteps that whole class of bug and scales to N concurrent digs for
  // free.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setSessions((prev) => {
        let changed = false;
        const next: Record<string, DigSessionState> = {};
        for (const [key, s] of Object.entries(prev)) {
          if (s.status === "digging") {
            let updated = s;
            while (updated.strikeIndex < updated.strikeIncrements.length && now >= updated.nextStrikeAt) {
              const amount = updated.strikeIncrements[updated.strikeIndex];
              const burstSize = 5 + Math.floor(Math.random() * 3);
              const burst: Particle[] = Array.from({ length: burstSize }, () => ({
                id: particleIdCounter++,
                left: 20 + Math.random() * 60,
                emoji: Math.random() < 0.55 ? "💎" : "✨",
                big: Math.random() < 0.35,
              }));
              updated = {
                ...updated,
                crystalsShown: Math.min(updated.floorEstimate, updated.crystalsShown + amount),
                strikeIndex: updated.strikeIndex + 1,
                strikeKey: updated.strikeKey + 1,
                nextStrikeAt: updated.nextStrikeAt + STRIKE_MS,
                popups: [...updated.popups.slice(-2), { id: popupIdCounter++, amount }],
                particles: [...updated.particles.slice(-16), ...burst],
              };
              changed = true;
            }
            const elapsedSec = Math.floor((now - updated.startTs) / 1000);
            if (updated.totalDuration > 0 && elapsedSec >= updated.totalDuration) {
              updated = { ...updated, status: "resolving", crystalsShown: updated.floorEstimate };
              changed = true;
            }
            next[key] = updated;
          } else if (s.status === "revealing" && now >= s.revealUntil) {
            next[key] = { ...s, status: "done" };
            changed = true;
          } else {
            next[key] = s;
          }
        }
        return changed ? next : prev;
      });
    }, TICK_MS);
    return () => clearInterval(interval);
  }, []);

  const resolveSession = useCallback(
    async (sessionId: bigint) => {
      try {
        // Must be captured BEFORE the /api/dig-reveal call, not after — the
        // resolver's handler awaits resolveDig's .rpc() (which itself
        // waits for on-chain confirmation) before responding, so by the
        // time that fetch resolves the mint has already landed. Reading
        // "before" afterwards was capturing a balance that already
        // included this session's own reward, making every delta compute
        // to 0 regardless of the real (nonzero) mint amount.
        const balanceBefore = await refreshMineBalance(digConfigData?.mineMint);

        // Same fix as Mines' /reveal: this endpoint used to accept a
        // settle request for ANY sessionId from anyone, no proof the
        // caller was that session's own player — anyone could force-settle
        // someone else's dig the instant its timer elapsed. Now signed
        // off-chain (wallet.signMessage, no transaction/fee) and verified
        // by the resolver against the session's actual owner.
        if (!wallet.signMessage || !wallet.publicKey) {
          throw new Error("This wallet doesn't support message signing, which settling now requires for security.");
        }
        const message = `mines-dig-reveal:${sessionId.toString()}`;
        const signatureBytes = await wallet.signMessage(new TextEncoder().encode(message));
        const signature = Buffer.from(signatureBytes).toString("base64");

        const res = await fetch(`/api/dig-reveal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionId.toString(), player: wallet.publicKey.toBase58(), signature }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `resolver returned ${res.status}`);
        }

        const [session] = digSessionPda(sessionId);
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 1200));
          const sessionAccount: any = await (program as any).account.digSession.fetch(session);
          if (sessionAccount.status === 1) {
            const balanceAfter = await refreshMineBalance(digConfigData?.mineMint);
            const result: DigResult = {
              rarityHit: sessionAccount.rarityHit,
              mineEarned: Math.max(0, balanceAfter - balanceBefore),
            };
            setSessions((prev) => {
              const cur = prev[sessionId.toString()];
              if (!cur) return prev;
              return {
                ...prev,
                [sessionId.toString()]: {
                  ...cur,
                  status: "revealing",
                  result,
                  revealUntil: Date.now() + REVEAL_MS,
                },
              };
            });
            return;
          }
        }
        throw new Error("resolver didn't settle in time");
      } catch (err: any) {
        setSessions((prev) => {
          const cur = prev[sessionId.toString()];
          if (!cur) return prev;
          return { ...prev, [sessionId.toString()]: { ...cur, status: "error", error: err.message ?? String(err) } };
        });
      }
    },
    [program, digConfigData, refreshMineBalance, wallet.publicKey, wallet.signMessage],
  );

  // Kicks off the real settlement exactly once per session, as soon as it
  // enters "resolving" — dedup'd via resolvingRef since this effect
  // re-runs on every tick (sessions changes every TICK_MS).
  useEffect(() => {
    if (!program) return;
    for (const s of Object.values(sessions)) {
      const key = s.sessionId.toString();
      if (s.status === "resolving" && !resolvingRef.current.has(key)) {
        resolvingRef.current.add(key);
        resolveSession(s.sessionId);
      }
    }
  }, [sessions, program, resolveSession]);

  const toggleExpanded = useCallback((key: string) => {
    setSessions((prev) => {
      const cur = prev[key];
      if (!cur) return prev;
      return { ...prev, [key]: { ...cur, expanded: !cur.expanded } };
    });
  }, []);

  const dismissSession = useCallback((key: string) => {
    setSessions((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    resolvingRef.current.delete(key);
  }, []);

  const retrySession = useCallback((key: string) => {
    resolvingRef.current.delete(key);
    setSessions((prev) => {
      const cur = prev[key];
      if (!cur) return prev;
      return { ...prev, [key]: { ...cur, status: "resolving", error: null } };
    });
  }, []);

  const rarityTiers: RarityInfo[] = digConfigData
    ? digConfigData.rarityTiers.slice(0, digConfigData.activeRarityCount)
    : [];

  const sessionList = Object.entries(sessions).sort((a, b) => (a[1].sessionId < b[1].sessionId ? 1 : -1));
  const activeCount = sessionList.filter(([, s]) => s.status !== "done").length;

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
        You can run several digs at once — start another any time.
      </p>

      {digConfigData && (
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
            {activeCount > 0 ? `Start another dig (${activeCount} active)` : "Start Dig"}
          </button>
        </div>
      )}

      {resuming && <p className="status-banner">Checking for in-progress digs...</p>}

      {sessionList.length > 0 && (
        <div className="dig-list">
          {sessionList.map(([key, s]) => (
            <DigSessionRow
              key={key}
              session={s}
              label={DIG_TIER_LABELS[s.durationTier] ?? `Tier ${s.durationTier}`}
              onToggle={() => toggleExpanded(key)}
              onDismiss={() => dismissSession(key)}
              onRetry={() => retrySession(key)}
            />
          ))}
        </div>
      )}

      {error && <p className="error-banner">{error}</p>}
      {!digConfigData && <p className="status-banner">Loading dig configuration...</p>}
    </div>
  );
}

function DigSessionRow({
  session: s,
  label,
  onToggle,
  onDismiss,
  onRetry,
}: {
  session: DigSessionState;
  label: string;
  onToggle: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  const secondsLeft = Math.max(0, s.totalDuration - Math.floor((Date.now() - s.startTs) / 1000));
  const progressPct = s.totalDuration > 0 ? Math.min(100, ((s.totalDuration - secondsLeft) / s.totalDuration) * 100) : 0;

  const statusLabel =
    s.status === "digging"
      ? `${secondsLeft}s left`
      : s.status === "resolving"
        ? "Settling..."
        : s.status === "revealing"
          ? "Revealing!"
          : s.status === "error"
            ? "Failed"
            : s.result
              ? `+${s.result.mineEarned.toFixed(2)} $MINE`
              : "Done";

  return (
    <div className={`dig-row-wrap${s.expanded ? " expanded" : ""}`}>
      <button className={`dig-row status-${s.status}`} onClick={onToggle}>
        <span className="dig-row-tier">{label}</span>
        <span className="dig-row-status">{statusLabel}</span>
        <div className="dig-row-bar">
          <div className="dig-row-bar-fill" style={{ width: `${s.status === "digging" ? progressPct : 100}%` }} />
        </div>
        <span className="dig-row-caret">{s.expanded ? "▾" : "▸"}</span>
      </button>

      {s.expanded && (
        <div className="panel dig-active">
          <div className="dig-timer">
            {s.status === "digging"
              ? `${secondsLeft}s`
              : s.status === "resolving"
                ? "Final strike..."
                : s.status === "error"
                  ? "Something went wrong"
                  : ""}
          </div>

          <div className={`mine-scene${s.status === "resolving" ? " charging" : ""}`}>
            <div className="crystal-stream">
              {s.particles.map((p) => (
                <span key={p.id} className={`crystal-particle${p.big ? " big" : ""}`} style={{ left: `${p.left}%` }}>
                  {p.emoji}
                </span>
              ))}
            </div>

            {s.status !== "error" && (
              <>
                <div className="mine-scene-figures">
                  <MinerFigure struck={s.status === "revealing"} />
                  <span className={`mine-rock hit${s.status === "revealing" ? " struck" : ""}`} key={s.strikeKey}>
                    🪨
                  </span>
                </div>
                {s.status !== "revealing" &&
                  s.popups.map((p) => (
                    <span key={p.id} className="strike-popup" style={{ left: `${30 + Math.random() * 40}%` }}>
                      +{p.amount.toFixed(1)}
                    </span>
                  ))}
              </>
            )}

            {s.status === "revealing" && s.result && (
              <div className="reveal-overlay">
                <div className={`reveal-flash${s.result.rarityHit === 0xff ? " common" : ""}`} />
                {s.result.rarityHit !== 0xff && (
                  <div className="confetti">
                    {Array.from({ length: 30 }, (_, i) => (
                      <span
                        key={i}
                        style={{
                          left: `${Math.random() * 100}%`,
                          animationDelay: `${Math.random() * 0.3}s`,
                          background: RARITY_COLORS[s.result!.rarityHit % RARITY_COLORS.length],
                        }}
                      />
                    ))}
                  </div>
                )}
                <div
                  className="reveal-gem"
                  style={
                    s.result.rarityHit !== 0xff
                      ? { filter: `drop-shadow(0 0 24px ${RARITY_COLORS[s.result.rarityHit % RARITY_COLORS.length]})` }
                      : undefined
                  }
                >
                  💎
                </div>
                {s.result.rarityHit !== 0xff && (
                  <div className="reveal-rarity" style={{ color: RARITY_COLORS[s.result.rarityHit % RARITY_COLORS.length] }}>
                    {RARITY_NAMES[s.result.rarityHit] ?? "Bonus"} find!
                  </div>
                )}
                <div className="reveal-text">+{s.result.mineEarned.toFixed(2)} $MINE</div>
              </div>
            )}
          </div>

          {s.status !== "revealing" && s.status !== "error" && (
            <div className="crystal-counter" key={Math.floor(s.crystalsShown * 10)}>
              <span className="crystal-icon">💎</span>
              {s.crystalsShown.toFixed(1)} $MINE
            </div>
          )}
          {s.status === "digging" && (
            <div className="dig-progress-track">
              <div className="dig-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
          )}

          {s.status === "error" && (
            <>
              <p className="error-banner">{s.error}</p>
              <button className="start-dig-btn" onClick={onRetry}>
                Retry settlement
              </button>
            </>
          )}

          {s.status === "done" && s.result && (
            <div className={`result-banner ${s.result.rarityHit === 0xff ? "win" : "win jackpot"}`}>
              <div className="result-headline">
                {s.result.rarityHit === 0xff ? "Dig complete" : `${RARITY_NAMES[s.result.rarityHit] ?? "Bonus"} find!`}
              </div>
              <div className="result-amount">+{s.result.mineEarned.toFixed(2)} $MINE</div>
              <button className="start-dig-btn" style={{ marginTop: 16 }} onClick={onDismiss}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
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
