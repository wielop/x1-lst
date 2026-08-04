"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN, type Idl } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import {
  PROGRAM_ID,
  stakingPoolPda,
  stakingAuthorityPda,
  rewardVaultPda,
  stakeTokenVaultPda,
  stakePositionPda,
} from "@/lib/config";
import idl from "@/lib/idl/mines.json";

const ACC_REWARD_SCALE = 1_000_000_000_000n;

function weightOf(pos: any): bigint {
  if (!pos) return 0n;
  return BigInt(pos.lockedWeight.toString()) + BigInt(pos.burnedWeight.toString());
}

export function StakingPanel() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [poolData, setPoolData] = useState<any>(null);
  const [positionData, setPositionData] = useState<any>(null);
  const [rewardPoolXnt, setRewardPoolXnt] = useState<number | null>(null);
  const [mineWalletBalance, setMineWalletBalance] = useState<number | null>(null);
  const [amount, setAmount] = useState("10");
  const [lockTier, setLockTier] = useState(0);
  const [burnAmount, setBurnAmount] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

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

      const [rewardVault] = rewardVaultPda();
      const rewardVaultInfo = await connection.getAccountInfo(rewardVault).catch(() => null);
      setRewardPoolXnt(rewardVaultInfo ? rewardVaultInfo.lamports / 1e9 : 0);

      if (wallet.publicKey) {
        const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
        const ata = getAssociatedTokenAddressSync(data.mineMint, wallet.publicKey);
        const info = await connection.getTokenAccountBalance(ata).catch(() => null);
        setMineWalletBalance(info ? info.value.uiAmount ?? 0 : 0);

        const [position] = stakePositionPda(wallet.publicKey);
        const pos = await (program.account as any).stakePosition.fetch(position).catch(() => null);
        setPositionData(pos);
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

  const pendingYield = useMemo(() => {
    if (!positionData || !poolData) return 0;
    const accrued = (weightOf(positionData) * BigInt(poolData.accRewardPerWeight.toString())) / ACC_REWARD_SCALE;
    const debt = BigInt(positionData.rewardDebt.toString());
    const newlyAccrued = accrued > debt ? accrued - debt : 0n;
    const banked = BigInt(positionData.unclaimedLamports.toString());
    return Number(banked + newlyAccrued) / 1e9;
  }, [positionData, poolData]);

  const lockupRemainingSec = useMemo(() => {
    if (!positionData) return 0;
    return Math.max(0, Number(positionData.unlockAt) - Math.floor(Date.now() / 1000));
  }, [positionData]);

  const lockTiers: { durationSeconds: number; weightMultiplierBps: number }[] = poolData
    ? poolData.lockTiers.slice(0, poolData.activeLockTierCount)
    : [];

  // StakePosition doesn't store which tier button was picked, only the
  // resulting locked_weight — recover the tier by matching its implied
  // multiplier (locked_weight / locked_amount) back against the pool's
  // configured tiers, so the "active lock" banner can show duration/
  // multiplier without needing a new on-chain field.
  const activeLockTierIndex = useMemo(() => {
    if (!positionData || lockTiers.length === 0) return -1;
    const lockedAmount = BigInt(positionData.lockedAmount.toString());
    if (lockedAmount === 0n) return -1;
    const lockedWeight = BigInt(positionData.lockedWeight.toString());
    const multiplierBps = Number((lockedWeight * 10_000n) / lockedAmount);
    let best = -1;
    let bestDiff = Infinity;
    lockTiers.forEach((tier, i) => {
      const diff = Math.abs(tier.weightMultiplierBps - multiplierBps);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    });
    return best;
  }, [positionData, lockTiers]);

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

  const doStake = useCallback(() => {
    if (!program || !wallet.publicKey || !poolData) return;
    return runTx(async () => {
      const [pool] = stakingPoolPda();
      const [position] = stakePositionPda(wallet.publicKey!);
      const [rewardVault] = rewardVaultPda();
      const [stakeTokenVault] = stakeTokenVaultPda();
      const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
      const stakerMineAta = getAssociatedTokenAddressSync(poolData.mineMint, wallet.publicKey!);
      const raw = new BN(Math.round(Number(amount) * 1e6));
      const sig = await program.methods
        .stake(raw, lockTier)
        .accounts({
          staker: wallet.publicKey!,
          stakingPool: pool,
          position,
          rewardVault,
          stakeTokenVault,
          stakerMineAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      setNotice(`Locked ${amount} $MINE`);
      return sig;
    });
  }, [program, wallet.publicKey, poolData, amount, lockTier, runTx]);

  const doBurnAndBoost = useCallback(() => {
    if (!program || !wallet.publicKey || !poolData) return;
    return runTx(async () => {
      const [pool] = stakingPoolPda();
      const [position] = stakePositionPda(wallet.publicKey!);
      const [rewardVault] = rewardVaultPda();
      const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
      const stakerMineAta = getAssociatedTokenAddressSync(poolData.mineMint, wallet.publicKey!);
      const raw = new BN(Math.round(Number(burnAmount) * 1e6));
      const sig = await program.methods
        .burnAndBoost(raw)
        .accounts({
          staker: wallet.publicKey!,
          stakingPool: pool,
          position,
          rewardVault,
          mineMint: poolData.mineMint,
          stakerMineAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      setNotice(`Permanently burned ${burnAmount} $MINE for a ${(poolData.burnWeightMultiplierBps / 10000).toFixed(1)}x weight boost`);
      return sig;
    });
  }, [program, wallet.publicKey, poolData, burnAmount, runTx]);

  const doUnstake = useCallback(() => {
    if (!program || !wallet.publicKey || !poolData || !positionData) return;
    return runTx(async () => {
      const [pool] = stakingPoolPda();
      const [position] = stakePositionPda(wallet.publicKey!);
      const [rewardVault] = rewardVaultPda();
      const [stakeTokenVault] = stakeTokenVaultPda();
      const [stakingAuthority] = stakingAuthorityPda();
      const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
      const stakerMineAta = getAssociatedTokenAddressSync(poolData.mineMint, wallet.publicKey!);
      const sig = await program.methods
        .unstake()
        .accounts({
          staker: wallet.publicKey!,
          stakingPool: pool,
          position,
          rewardVault,
          stakeTokenVault,
          stakingAuthority,
          stakerMineAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      setNotice("Unlocked and withdrawn");
      return sig;
    });
  }, [program, wallet.publicKey, poolData, positionData, runTx]);

  const doClaim = useCallback(() => {
    if (!program || !wallet.publicKey) return;
    return runTx(async () => {
      const [pool] = stakingPoolPda();
      const [position] = stakePositionPda(wallet.publicKey!);
      const [rewardVault] = rewardVaultPda();
      const sig = await program.methods
        .claimYield()
        .accounts({ staker: wallet.publicKey!, stakingPool: pool, position, rewardVault })
        .rpc();
      setNotice(`Claimed ${pendingYield.toFixed(5)} XNT`);
      return sig;
    });
  }, [program, wallet.publicKey, runTx, pendingYield]);

  const hasLock = positionData && Number(positionData.lockedAmount) > 0;
  const hasBurned = positionData && BigInt(positionData.burnedWeight.toString()) > 0n;

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

      <p className="rules">
        Lock or burn $MINE to earn a pro-rata share of the real XNT reward pool below — auto-funded from a small
        skim off every Mines/Wykop wager, not from new token emission. Your share of that pool = your weight ÷
        everyone's weight. Neither locking nor burning pays out immediately: they only change your share going
        forward, so yield only shows up once new wagers happen and skim more XNT in.
      </p>

      {!poolData && <p className="status-banner">Loading staking pool...</p>}

      {poolData && (
        <>
          <div className="panel stake-stats">
            <div className="stake-stat">
              <span className="stake-stat-label">Reward pool (XNT)</span>
              <span className="stake-stat-value gold">{(rewardPoolXnt ?? 0).toFixed(5)} XNT</span>
            </div>
            <div className="stake-stat">
              <span className="stake-stat-label">Locked</span>
              <span className="stake-stat-value">
                {positionData ? (Number(positionData.lockedAmount) / 1e6).toFixed(2) : "0.00"} $MINE
              </span>
            </div>
            <div className="stake-stat">
              <span className="stake-stat-label">
                Pending yield <span className="live-dot" title="Auto-refreshing every few seconds" />
              </span>
              <span className="stake-stat-value gold">{pendingYield.toFixed(5)} XNT</span>
              <span className="stake-stat-sub">
                {lastUpdated ? `updated ${Math.max(0, Math.floor((nowTick - lastUpdated) / 1000))}s ago` : "..."}
              </span>
            </div>
            <div className="stake-stat">
              <span className="stake-stat-label">Total weight (pool)</span>
              <span className="stake-stat-value">{(Number(poolData.totalWeight) / 1e6).toFixed(1)}</span>
            </div>
          </div>

          {hasLock && (
            <p className="status-banner status-cashed_out">
              🔒 {(Number(positionData.lockedAmount) / 1e6).toFixed(2)} $MINE locked
              {activeLockTierIndex >= 0 && (
                <>
                  {" "}
                  in the{" "}
                  {lockTiers[activeLockTierIndex].durationSeconds === 0
                    ? "No lock"
                    : formatDuration(lockTiers[activeLockTierIndex].durationSeconds)}{" "}
                  tier ({(lockTiers[activeLockTierIndex].weightMultiplierBps / 10000).toFixed(1)}x weight)
                </>
              )}
              {lockupRemainingSec > 0
                ? ` — unlocks in ${formatDuration(lockupRemainingSec)}`
                : " — unlock period over, ready to withdraw"}
              . Your share of the reward pool now reflects this weight; it does not pay out on its own — it accrues
              as new wagers add XNT to the pool above.
            </p>
          )}

          {hasBurned && (
            <p className="status-banner status-cashed_out">
              🔥 {(Number(positionData.burnedWeight) / 1e6).toFixed(2)} permanent weight from burned $MINE — those
              tokens are gone forever, but this weight (and the bigger share of the reward pool it gives you) never
              expires and can never be removed.
            </p>
          )}

          <div className="panel">
            <p className="rules" style={{ marginTop: 0 }}>
              <strong>Lock:</strong> your $MINE stays yours — you get it all back once the lock ends. While locked
              it counts as weight (tier multiplier × amount) toward your share of the reward pool.
            </p>
            <div className="lock-tier-picker">
              {lockTiers.map((tier, i) => (
                <button
                  key={i}
                  className={`tier-option${lockTier === i ? " selected" : ""}`}
                  onClick={() => setLockTier(i)}
                  disabled={busy || hasLock}
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
                <input value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy || hasLock} />
              </label>
              <button onClick={doStake} disabled={busy || !program || !amount || hasLock}>
                Lock
              </button>
            </div>
            {hasLock && (
              <p className="error-banner" style={{ marginTop: 8, marginBottom: 0 }}>
                You can only have one active lock at a time — this program doesn't support adding to an existing
                lock or switching tiers mid-lock. Wait for it to unlock, hit "Unlock all" below to withdraw it, then
                lock again with a new amount/tier.
              </p>
            )}
          </div>

          <div className="panel">
            <p className="rules" style={{ marginTop: 0 }}>
              <strong>Burn:</strong> destroys your $MINE permanently — you never get these tokens back, ever. In
              exchange you get a permanent weight boost (bigger, forever, than locking the same amount) — a bigger
              share of the reward pool above, for as long as the pool exists. It does not pay out anything by
              itself; check "Pending yield" above, which only grows once new wagers skim more XNT into the pool.
            </p>
            <div className="controls">
              <label>
                Burn amount ($MINE)
                <input value={burnAmount} onChange={(e) => setBurnAmount(e.target.value)} disabled={busy} />
              </label>
              <button onClick={doBurnAndBoost} disabled={busy || !program || !burnAmount} className="burn-btn">
                🔥 Burn for {(poolData.burnWeightMultiplierBps / 10000).toFixed(1)}x (permanent)
              </button>
            </div>
          </div>

          {(hasLock || hasBurned) && (
            <div className="panel">
              <div className="controls">
                <button onClick={doClaim} disabled={busy || pendingYield <= 0} className="cashout">
                  Claim {pendingYield.toFixed(5)} XNT
                </button>
                {hasLock && (
                  <button onClick={doUnstake} disabled={busy || lockupRemainingSec > 0}>
                    {lockupRemainingSec > 0 ? `Locked ${formatDuration(lockupRemainingSec)}` : "Unlock all"}
                  </button>
                )}
              </div>
            </div>
          )}

          {notice && <p className="status-banner status-cashed_out">{notice}</p>}
          {error && <p className="error-banner">{error}</p>}
        </>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.ceil(seconds / 3600)}h`;
  return `${Math.ceil(seconds / 86400)}d`;
}
