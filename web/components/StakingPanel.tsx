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
  const [mineWalletBalance, setMineWalletBalance] = useState<number | null>(null);
  const [amount, setAmount] = useState("10");
  const [lockTier, setLockTier] = useState(0);
  const [burnAmount, setBurnAmount] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

      if (wallet.publicKey) {
        const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
        const ata = getAssociatedTokenAddressSync(data.mineMint, wallet.publicKey);
        const info = await connection.getTokenAccountBalance(ata).catch(() => null);
        setMineWalletBalance(info ? info.value.uiAmount ?? 0 : 0);

        const [position] = stakePositionPda(wallet.publicKey);
        const pos = await (program.account as any).stakePosition.fetch(position).catch(() => null);
        setPositionData(pos);
      }
    } catch {
      // staking pool not initialized yet, or RPC hiccup
    }
  }, [program, wallet.publicKey, connection]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

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
        Lock $MINE to earn a pro-rata share of real XNT platform revenue — auto-funded from a small skim off every
        Mines/Wykop wager, not from new token emission. Longer locks earn a bigger share on the same tokens.
        Permanently burning $MINE instead earns an even bigger share, forever — real supply reduction, not just a
        temporary lock.
      </p>

      {!poolData && <p className="status-banner">Loading staking pool...</p>}

      {poolData && (
        <>
          <div className="panel stake-stats">
            <div className="stake-stat">
              <span className="stake-stat-label">Locked</span>
              <span className="stake-stat-value">
                {positionData ? (Number(positionData.lockedAmount) / 1e6).toFixed(2) : "0.00"} $MINE
              </span>
            </div>
            <div className="stake-stat">
              <span className="stake-stat-label">Pending yield</span>
              <span className="stake-stat-value gold">{pendingYield.toFixed(5)} XNT</span>
            </div>
            <div className="stake-stat">
              <span className="stake-stat-label">Total weight (pool)</span>
              <span className="stake-stat-value">{(Number(poolData.totalWeight) / 1e6).toFixed(1)}</span>
            </div>
          </div>

          {hasBurned && (
            <p className="status-banner status-cashed_out">
              🔥 {(Number(positionData.burnedWeight) / 1e6).toFixed(2)} permanent weight from burned $MINE (never
              expires, never returns)
            </p>
          )}

          <div className="panel">
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
              <p className="rules" style={{ marginTop: 8, marginBottom: 0 }}>
                Already have an active lock — unlock it first to choose a different tier.
              </p>
            )}
          </div>

          <div className="panel">
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
