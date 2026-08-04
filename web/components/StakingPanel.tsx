"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN, type Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  PROGRAM_ID,
  stakingPoolPda,
  stakingAuthorityPda,
  rewardVaultPda,
  stakeTokenVaultPda,
  positionPda,
  poolXntVaultPda,
  poolMineVaultPda,
} from "@/lib/config";
import idl from "@/lib/idl/mines.json";

const ACC_REWARD_SCALE = 1_000_000_000_000n;

type PositionRow = {
  publicKey: PublicKey;
  positionId: bigint;
  kind: "lock" | "burn";
  amount: bigint;
  weight: bigint;
  unlockAt: number;
  rewardDebt: bigint;
  unclaimedLamports: bigint;
  expired: boolean;
};

function decodePosition(publicKey: PublicKey, account: any): PositionRow {
  return {
    publicKey,
    positionId: BigInt(account.positionId.toString()),
    kind: account.kind.lock !== undefined ? "lock" : "burn",
    amount: BigInt(account.amount.toString()),
    weight: BigInt(account.weight.toString()),
    unlockAt: Number(account.unlockAt),
    rewardDebt: BigInt(account.rewardDebt.toString()),
    unclaimedLamports: BigInt(account.unclaimedLamports.toString()),
    expired: account.expired,
  };
}

function pendingYieldOf(pos: PositionRow, accRewardPerWeight: bigint): number {
  const accrued = (pos.weight * accRewardPerWeight) / ACC_REWARD_SCALE;
  const newlyAccrued = accrued > pos.rewardDebt ? accrued - pos.rewardDebt : 0n;
  return Number(pos.unclaimedLamports + newlyAccrued) / 1e9;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.ceil(seconds / 3600)}h`;
  return `${Math.ceil(seconds / 86400)}d`;
}

/** Small click-to-toggle "ⓘ" popover — keeps the default UI to one short
 * line, with the full explanation available on demand instead of always
 * on screen. */
function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info-tip">
      <button
        type="button"
        className="info-tip-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="More info"
      >
        ⓘ
      </button>
      {open && (
        <>
          <div className="info-tip-backdrop" onClick={() => setOpen(false)} />
          <div className="info-tip-popover">{text}</div>
        </>
      )}
    </span>
  );
}

export function StakingPanel() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [poolData, setPoolData] = useState<any>(null);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [rewardPoolXnt, setRewardPoolXnt] = useState<number | null>(null);
  const [mineWalletBalance, setMineWalletBalance] = useState<number | null>(null);
  const [lockAmount, setLockAmount] = useState("10");
  const [lockTier, setLockTier] = useState(0);
  const [burnAmount, setBurnAmount] = useState("5");
  const [burnTier, setBurnTier] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  // Rolling window of (timestamp, acc_reward_per_weight) samples observed
  // this session — acc_reward_per_weight only ever increases (see
  // settle_unallocated/route_wager_skim in lib.rs), so unlike raw pending
  // yield it's a clean signal to derive a real, non-fabricated "recent
  // accrual rate" from: how fast has it ACTUALLY been growing lately.
  const [accSamples, setAccSamples] = useState<{ ts: number; acc: bigint }[]>([]);
  // Per-position last-claim record, populated only from actions taken in
  // THIS session (not fetched history) — honest about what it actually is.
  const [lastClaims, setLastClaims] = useState<Record<string, { amount: number; ts: number }>>({});
  // Pool-wide stats (every wallet's positions, not just the connected
  // one) — mirrors the "Pool Statistics" panel style from the
  // staging-vero.x1.xyz staking reference.
  const [poolStats, setPoolStats] = useState<{ tvlMine: number; tvlXnt: number; totalStakers: number } | null>(
    null,
  );
  const [showCompleted, setShowCompleted] = useState(false);

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

  const refresh = useCallback(async () => {
    if (!program) return;
    try {
      const [pool] = stakingPoolPda();
      const data = await (program.account as any).stakingPool.fetch(pool);
      setPoolData(data);

      const acc = BigInt(data.accRewardPerWeight.toString());
      setAccSamples((prev) => {
        const next = [...prev, { ts: Date.now(), acc }];
        const cutoff = Date.now() - 10 * 60 * 1000; // keep a 10-minute window
        return next.filter((s) => s.ts >= cutoff).slice(-200);
      });

      const [rewardVault] = rewardVaultPda();
      const rewardVaultInfo = await connection.getAccountInfo(rewardVault).catch(() => null);
      setRewardPoolXnt(rewardVaultInfo ? rewardVaultInfo.lamports / 1e9 : 0);

      // Pool-wide: every position on the program, not just this wallet's —
      // needed for Total Value Locked / Total Stakers. TVL only counts
      // still-active Lock principal (Burn destroyed its tokens, so there's
      // no "value" left to count there), converted to an XNT-equivalent
      // via the AMM's live spot price for a TVL figure comparable to the
      // staging-vero reference (which stakes a single asset, XNT itself).
      const [allRaw, xntVaultInfo, mineVaultBal] = await Promise.all([
        (program.account as any).position.all() as Promise<any[]>,
        connection.getAccountInfo(poolXntVaultPda()[0]).catch(() => null),
        connection.getTokenAccountBalance(poolMineVaultPda()[0]).catch(() => null),
      ]);
      const reserveXnt = xntVaultInfo ? xntVaultInfo.lamports : 0;
      const reserveMine = mineVaultBal ? Number(mineVaultBal.value.amount) : 0;
      const mineToXnt = reserveMine > 0 ? reserveXnt / reserveMine : 0;

      let tvlMineRaw = 0;
      const stakerSet = new Set<string>();
      for (const r of allRaw) {
        const acc = r.account;
        if (acc.expired) continue;
        stakerSet.add(acc.owner.toBase58());
        if (acc.kind.lock !== undefined) {
          tvlMineRaw += Number(acc.amount.toString());
        }
      }
      const tvlMine = tvlMineRaw / 1e6;
      setPoolStats({ tvlMine, tvlXnt: (tvlMineRaw * mineToXnt) / 1e9, totalStakers: stakerSet.size });

      if (wallet.publicKey) {
        const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
        const ata = getAssociatedTokenAddressSync(data.mineMint, wallet.publicKey);
        const info = await connection.getTokenAccountBalance(ata).catch(() => null);
        setMineWalletBalance(info ? info.value.uiAmount ?? 0 : 0);

        // Position.owner sits right after the 8-byte Anchor discriminator.
        const raw = await (program.account as any).position.all([
          { memcmp: { offset: 8, bytes: wallet.publicKey.toBase58() } },
        ]);
        const decoded: PositionRow[] = raw.map((r: any) => decodePosition(r.publicKey, r.account));
        decoded.sort((a, b) => (a.positionId < b.positionId ? 1 : -1));
        setPositions(decoded);
      }
      setLastUpdated(Date.now());
    } catch {
      // staking pool not initialized yet, or RPC hiccup
    }
  }, [program, wallet.publicKey, connection]);

  // Reward accrual only actually changes when someone's wager skims XNT
  // into the pool (an on-chain event, not a continuous per-second thing) —
  // so there's no honest way to animate this number smoothly between real
  // updates without it being just as misleading as the old Wykop crystal
  // counter. Instead: poll fast enough that any real accrual shows up
  // within a few seconds, and show a live "updated Xs ago" indicator so
  // it's clear this is actively being watched, not stale.
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3_000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    const tick = setInterval(() => setNowTick(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, []);

  // Deliberately the RAW on-chain value, not a projected post-sweep one.
  // An earlier version of this projected what settle_unallocated() would
  // do if it ran right now (unallocated_rewards / current total_weight) —
  // mathematically accurate for existing positions, but it meant a
  // brand-new position opened right after a stranded backlog built up
  // (while nobody was staked) would immediately show — and could actually
  // claim — a share of rewards that predate its own existence, just for
  // being the only/majority weight-holder the moment a sweep triggers.
  // That's a real windfall, not a display bug, so showing it early was
  // actively misleading rather than merely "eager." Sticking to the raw
  // value means pending only ever reflects reward growth that has ALREADY
  // landed on-chain — in practice this catches up on its own almost
  // immediately now, since every wager skim updates acc_reward_per_weight
  // live as soon as total_weight > 0 (see route_wager_skim /
  // route_wykop_wager), which it is as soon as anyone has an open position.
  const accRewardPerWeight = poolData ? BigInt(poolData.accRewardPerWeight.toString()) : 0n;

  // Honest "how fast is this filling up" estimate: a straight-line rate
  // between the oldest and newest sample in the window, in XNT per unit
  // weight per hour. Requires at least ~20s of real observed spread so a
  // page-load blip can't produce a wild extrapolated number, and is null
  // (shown as "gathering data...") until then — never a fabricated/assumed
  // rate, only ever derived from what actually happened on-chain this
  // session.
  const recentAccrualPerWeightPerHour = useMemo(() => {
    if (accSamples.length < 2) return null;
    const oldest = accSamples[0];
    const newest = accSamples[accSamples.length - 1];
    const dtMs = newest.ts - oldest.ts;
    if (dtMs < 20_000) return null;
    const dAcc = newest.acc - oldest.acc;
    if (dAcc <= 0n) return 0;
    const perMs = Number(dAcc) / dtMs;
    const perHour = (perMs * 3_600_000) / Number(ACC_REWARD_SCALE) / 1e9; // XNT per unit weight per hour
    return perHour;
  }, [accSamples]);

  const poolAccrualXntPerHour =
    recentAccrualPerWeightPerHour != null && poolData
      ? recentAccrualPerWeightPerHour * Number(poolData.totalWeight)
      : null;

  // Estimated APY, same "recent observed rate" honesty as
  // poolAccrualXntPerHour — annualized reward flow against TVL's
  // XNT-equivalent value. Needs a real, nonzero AMM price to mean
  // anything (division by tvlXnt), so null (shown as "-") until both the
  // rate and a priced TVL exist.
  const estimatedApyPct =
    poolAccrualXntPerHour != null && poolStats && poolStats.tvlXnt > 0
      ? ((poolAccrualXntPerHour * 24 * 365) / poolStats.tvlXnt) * 100
      : null;

  const totalPendingYield = useMemo(
    () => positions.reduce((sum, p) => sum + pendingYieldOf(p, accRewardPerWeight), 0),
    [positions, accRewardPerWeight],
  );
  const totalLocked = useMemo(
    () => positions.filter((p) => p.kind === "lock" && !p.expired).reduce((sum, p) => sum + p.amount, 0n),
    [positions],
  );
  const totalBurnWeight = useMemo(
    () => positions.filter((p) => p.kind === "burn" && !p.expired).reduce((sum, p) => sum + p.weight, 0n),
    [positions],
  );
  // A position is "done" once it's expired/withdrawn AND has nothing left
  // to claim — keeping those out of the default view is most of what was
  // cluttering this list after a session of testing.
  const [activePositions, completedPositions] = useMemo(() => {
    const active: PositionRow[] = [];
    const completed: PositionRow[] = [];
    for (const p of positions) {
      if (p.expired && pendingYieldOf(p, accRewardPerWeight) <= 0) completed.push(p);
      else active.push(p);
    }
    return [active, completed];
  }, [positions, accRewardPerWeight]);

  const lockTiers: { durationSeconds: number; weightMultiplierBps: number }[] = poolData
    ? poolData.lockTiers.slice(0, poolData.activeLockTierCount)
    : [];
  const burnTiers: { durationSeconds: number; weightMultiplierBps: number }[] = poolData
    ? poolData.burnTiers.slice(0, poolData.activeBurnTierCount)
    : [];

  const runTx = useCallback(
    async (fn: () => Promise<string>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await fn();
        await refresh();
      } catch (err: any) {
        setError(err.message ?? String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const doOpenLock = useCallback(() => {
    if (!program || !wallet.publicKey || !poolData) return;
    return runTx(async () => {
      const [pool] = stakingPoolPda();
      const [position] = positionPda(wallet.publicKey!, BigInt(poolData.totalPositions.toString()));
      const [stakeTokenVault] = stakeTokenVaultPda();
      const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
      const stakerMineAta = getAssociatedTokenAddressSync(poolData.mineMint, wallet.publicKey!);
      const raw = new BN(Math.round(Number(lockAmount) * 1e6));
      const sig = await program.methods
        .openLock(raw, lockTier)
        .accounts({
          staker: wallet.publicKey!,
          stakingPool: pool,
          position,
          stakeTokenVault,
          stakerMineAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      setNotice(`Locked ${lockAmount} $MINE`);
      return sig;
    });
  }, [program, wallet.publicKey, poolData, lockAmount, lockTier, runTx]);

  const doOpenBurn = useCallback(() => {
    if (!program || !wallet.publicKey || !poolData) return;
    return runTx(async () => {
      const [pool] = stakingPoolPda();
      const [position] = positionPda(wallet.publicKey!, BigInt(poolData.totalPositions.toString()));
      const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
      const stakerMineAta = getAssociatedTokenAddressSync(poolData.mineMint, wallet.publicKey!);
      const raw = new BN(Math.round(Number(burnAmount) * 1e6));
      const sig = await program.methods
        .openBurn(raw, burnTier)
        .accounts({
          staker: wallet.publicKey!,
          stakingPool: pool,
          position,
          mineMint: poolData.mineMint,
          stakerMineAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      setNotice(`Burned ${burnAmount} $MINE for a ${(burnTiers[burnTier]?.weightMultiplierBps ?? 10000) / 10000}x boost`);
      return sig;
    });
  }, [program, wallet.publicKey, poolData, burnAmount, burnTier, burnTiers, runTx]);

  const claimYieldTx = useCallback(
    async (pos: PositionRow) => {
      const [pool] = stakingPoolPda();
      const [rewardVault] = rewardVaultPda();
      return program!.methods
        .claimYield(new BN(pos.positionId.toString()))
        .accounts({ staker: wallet.publicKey!, stakingPool: pool, position: pos.publicKey, rewardVault })
        .rpc();
    },
    [program, wallet.publicKey],
  );

  const doClaim = useCallback(
    (pos: PositionRow) => {
      if (!program || !wallet.publicKey) return;
      return runTx(async () => {
        const amount = pendingYieldOf(pos, accRewardPerWeight);
        const sig = await claimYieldTx(pos);
        setNotice(`Claimed ${amount.toFixed(5)} XNT`);
        setLastClaims((prev) => ({ ...prev, [pos.publicKey.toBase58()]: { amount, ts: Date.now() } }));
        return sig;
      });
    },
    [program, wallet.publicKey, runTx, accRewardPerWeight, claimYieldTx],
  );

  // Withdraw ($MINE principal, Lock only) and Claim (XNT yield) are two
  // separate on-chain instructions (expire_position does a token CPI and
  // can't also move lamports in the same call — see the note on
  // claim_yield in lib.rs), but there's no reason a player should have to
  // click twice at the end of a lock. This fires both, back to back,
  // behind a single button.
  const doClaimAll = useCallback(
    (pos: PositionRow) => {
      if (!program || !wallet.publicKey || !poolData) return;
      return runTx(async () => {
        const pendingBefore = pendingYieldOf(pos, accRewardPerWeight);
        const [pool] = stakingPoolPda();
        const [stakeTokenVault] = stakeTokenVaultPda();
        const [stakingAuthority] = stakingAuthorityPda();
        const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
        const ownerMineAta = getAssociatedTokenAddressSync(poolData.mineMint, wallet.publicKey!);
        try {
          await program.methods
            .expirePosition()
            .accounts({
              payer: wallet.publicKey!,
              stakingPool: pool,
              position: pos.publicKey,
              stakeTokenVault,
              stakingAuthority,
              ownerMineAta,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
        } catch (err: any) {
          // See doExpire — the background keeper may have already reaped
          // this one; that's fine, the $MINE is already back either way.
          if (!String(err.message ?? err).includes("AlreadyExpired")) throw err;
        }
        let sig = "";
        if (pendingBefore > 0) {
          sig = await claimYieldTx(pos);
          setLastClaims((prev) => ({
            ...prev,
            [pos.publicKey.toBase58()]: { amount: pendingBefore, ts: Date.now() },
          }));
        }
        setNotice(
          pendingBefore > 0
            ? `Withdrawn ${(Number(pos.amount) / 1e6).toFixed(2)} $MINE + claimed ${pendingBefore.toFixed(5)} XNT`
            : `Withdrawn ${(Number(pos.amount) / 1e6).toFixed(2)} $MINE`,
        );
        return sig;
      });
    },
    [program, wallet.publicKey, poolData, runTx, accRewardPerWeight, claimYieldTx],
  );

  return (
    <div className="mines-app">
      <header>
        <h1 className="staking-title">Stake $MINE</h1>
        <div className="header-right">
          {wallet.publicKey && mineWalletBalance !== null && (
            <span className="mine-balance">{mineWalletBalance.toFixed(2)} $MINE</span>
          )}
          <WalletMultiButton />
        </div>
      </header>

      <p className="rules-short">
        Lock or burn $MINE for a share of real XNT rewards.
        <InfoTip text="Auto-funded from a small skim off every Mines/Wykop wager, not new token emission. You can open as many locks and burns as you want, at any time — each is tracked and pays out independently. Locking is reversible (get your $MINE back once it ends); burning destroys the $MINE forever for a bigger weight boost. Neither pays out immediately — yield only shows up once new wagers skim more XNT into the pool." />
      </p>

      {!poolData && <p className="status-banner">Loading staking pool...</p>}

      {poolData && (
        <>
          <div className="panel stake-stats">
            <div className="stake-stat-header">Pool statistics</div>
            <div className="stake-stat">
              <span className="stake-stat-label">Total value locked</span>
              <span className="stake-stat-value">{(poolStats?.tvlMine ?? 0).toFixed(2)} $MINE</span>
              <span className="stake-stat-sub">
                {poolStats ? `≈ ${poolStats.tvlXnt.toFixed(5)} XNT` : "..."}
              </span>
            </div>
            <div className="stake-stat">
              <span className="stake-stat-label">Total stakers</span>
              <span className="stake-stat-value">{poolStats?.totalStakers ?? "-"}</span>
            </div>
            <div className="stake-stat">
              <span className="stake-stat-label">Estimated APY</span>
              <span className="stake-stat-value gold">{estimatedApyPct != null ? `${estimatedApyPct.toFixed(2)}%` : "-"}</span>
              <span className="stake-stat-sub">based on recent rate</span>
            </div>
            <div className="stake-stat">
              <span className="stake-stat-label">Total weight (pool)</span>
              <span className="stake-stat-value">{(Number(poolData.totalWeight) / 1e6).toFixed(1)}</span>
            </div>
          </div>

          <div className="panel stake-stats">
            <div className="stake-stat-header">Your position</div>
            <div className="stake-stat">
              <span className="stake-stat-label">Reward pool (XNT)</span>
              <span className="stake-stat-value gold">{(rewardPoolXnt ?? 0).toFixed(5)} XNT</span>
              <span className="stake-stat-sub">
                {poolAccrualXntPerHour != null
                  ? `~${poolAccrualXntPerHour.toFixed(5)} XNT/h (recent)`
                  : "gathering rate data..."}
              </span>
            </div>
            <div className="stake-stat">
              <span className="stake-stat-label">Your locked</span>
              <span className="stake-stat-value">{(Number(totalLocked) / 1e6).toFixed(2)} $MINE</span>
            </div>
            <div className="stake-stat">
              <span className="stake-stat-label">
                Pending yield <span className="live-dot" title="Auto-refreshing every few seconds" />
              </span>
              <span className="stake-stat-value gold">{totalPendingYield.toFixed(5)} XNT</span>
              <span className="stake-stat-sub">
                {lastUpdated ? `updated ${Math.max(0, Math.floor((nowTick - lastUpdated) / 1000))}s ago` : "..."}
              </span>
            </div>
          </div>

          {totalBurnWeight > 0n && (
            <p className="status-banner status-cashed_out">
              🔥 {(Number(totalBurnWeight) / 1e6).toFixed(2)} weight active from burns
            </p>
          )}

          <div className="panel">
            <h3 className="panel-heading">
              Lock $MINE
              <InfoTip text="Your $MINE stays yours — you get it all back once the lock ends. While locked it counts as weight (tier multiplier × amount) toward your share of the reward pool. You can open another lock any time, even while one is already active." />
            </h3>
            <div className="lock-tier-picker">
              {lockTiers.map((tier, i) => (
                <button
                  key={i}
                  className={`tier-option${lockTier === i ? " selected" : ""}`}
                  onClick={() => setLockTier(i)}
                  disabled={busy}
                >
                  <span className="tier-duration">
                    {tier.durationSeconds === 0 ? "No lock" : formatDuration(tier.durationSeconds)}
                  </span>
                  <span className="tier-price">{(tier.weightMultiplierBps / 10000).toFixed(1)}x weight</span>
                </button>
              ))}
            </div>

            <div className="controls">
              <label>
                Amount ($MINE)
                <input value={lockAmount} onChange={(e) => setLockAmount(e.target.value)} disabled={busy} />
              </label>
              <button onClick={doOpenLock} disabled={busy || !program || !lockAmount}>
                Lock
              </button>
            </div>
          </div>

          <div className="panel">
            <h3 className="panel-heading">
              Burn $MINE
              <InfoTip text="Destroys your $MINE permanently — you never get these tokens back. In exchange you get a weight boost until that tier's own expiry — shorter tiers pay a bigger multiplier since there's no lock-up cost offsetting them the way there is for a lock. It doesn't pay out by itself; check Pending yield, which only grows once new wagers skim more XNT into the pool." />
            </h3>
            <div className="lock-tier-picker">
              {burnTiers.map((tier, i) => (
                <button
                  key={i}
                  className={`tier-option${burnTier === i ? " selected" : ""}`}
                  onClick={() => setBurnTier(i)}
                  disabled={busy}
                >
                  <span className="tier-duration">{formatDuration(tier.durationSeconds)}</span>
                  <span className="tier-price">{(tier.weightMultiplierBps / 10000).toFixed(1)}x weight</span>
                </button>
              ))}
            </div>
            <div className="controls">
              <label>
                Burn amount ($MINE)
                <input value={burnAmount} onChange={(e) => setBurnAmount(e.target.value)} disabled={busy} />
              </label>
              <button onClick={doOpenBurn} disabled={busy || !program || !burnAmount} className="burn-btn">
                🔥 Burn
              </button>
            </div>
          </div>

          {positions.length > 0 && (
            <div className="panel">
              <div className="position-list">
                {(showCompleted ? positions : activePositions).map((pos) => {
                  const remaining = Math.max(0, pos.unlockAt - Math.floor(nowTick / 1000));
                  const pending = pendingYieldOf(pos, accRewardPerWeight);
                  const posRatePerHour =
                    recentAccrualPerWeightPerHour != null && !pos.expired
                      ? recentAccrualPerWeightPerHour * Number(pos.weight)
                      : null;
                  const lastClaim = lastClaims[pos.publicKey.toBase58()];
                  const infoBits: string[] = [];
                  if (posRatePerHour != null && posRatePerHour > 0) {
                    infoBits.push(`~${posRatePerHour.toFixed(5)} XNT/h`);
                  }
                  if (lastClaim) {
                    const agoSec = Math.max(0, Math.floor((nowTick - lastClaim.ts) / 1000));
                    infoBits.push(`last claim ${lastClaim.amount.toFixed(5)} XNT (${formatDuration(agoSec)} ago)`);
                  }
                  return (
                    <div key={pos.publicKey.toBase58()} className="position-row-wrap">
                      <div className={`position-row${pos.expired ? " expired" : ""}`}>
                        <span className="position-kind">{pos.kind === "lock" ? "🔒" : "🔥"}</span>
                        <span className="position-amount">{(Number(pos.amount) / 1e6).toFixed(2)} $MINE</span>
                        <span className="position-weight">{(Number(pos.weight) / 1e6).toFixed(1)}w</span>
                        <span className="position-status">
                          {pos.expired
                            ? pos.kind === "lock"
                              ? "withdrawn"
                              : "expired"
                            : remaining > 0
                              ? `${formatDuration(remaining)} left`
                              : "ready"}
                        </span>
                        <span className="position-pending">{pending > 0 ? `${pending.toFixed(5)} XNT` : ""}</span>
                        <span className="position-actions">
                          {!pos.expired && remaining === 0 ? (
                            <button onClick={() => doClaimAll(pos)} disabled={busy} className="cashout">
                              {pending > 0
                                ? pos.kind === "lock"
                                  ? "Withdraw + Claim"
                                  : "Reap + Claim"
                                : pos.kind === "lock"
                                  ? "Withdraw"
                                  : "Reap now"}
                            </button>
                          ) : (
                            pending > 0 && (
                              <button onClick={() => doClaim(pos)} disabled={busy} className="cashout">
                                Claim
                              </button>
                            )
                          )}
                        </span>
                      </div>
                      {infoBits.length > 0 && <div className="position-info">{infoBits.join(" · ")}</div>}
                    </div>
                  );
                })}
                {activePositions.length === 0 && !showCompleted && (
                  <p className="rules-short">Nothing active right now.</p>
                )}
              </div>
              {completedPositions.length > 0 && (
                <button className="show-completed-btn" onClick={() => setShowCompleted((v) => !v)}>
                  {showCompleted ? "Hide" : "Show"} completed ({completedPositions.length})
                </button>
              )}
            </div>
          )}

          {notice && <p className="status-banner status-cashed_out">{notice}</p>}
          {error && <p className="error-banner">{error}</p>}
        </>
      )}
    </div>
  );
}
