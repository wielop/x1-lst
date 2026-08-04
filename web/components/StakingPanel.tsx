"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN, type Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { PROGRAM_ID } from "@/lib/config";
import idl from "@/lib/idl/mines.json";

const ACC_REWARD_SCALE = 1_000_000_000_000n;

function stakingPoolPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("staking_pool")], PROGRAM_ID);
}
function stakingAuthorityPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("staking_authority")], PROGRAM_ID);
}
function rewardVaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("reward_vault")], PROGRAM_ID);
}
function stakeTokenVaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("stake_token_vault")], PROGRAM_ID);
}
function stakePositionPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("stake_position"), owner.toBuffer()], PROGRAM_ID);
}

export function StakingPanel() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [poolData, setPoolData] = useState<any>(null);
  const [positionData, setPositionData] = useState<any>(null);
  const [mineWalletBalance, setMineWalletBalance] = useState<number | null>(null);
  const [amount, setAmount] = useState("10");
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
    const accrued =
      (BigInt(positionData.stakedAmount.toString()) * BigInt(poolData.accRewardPerShare.toString())) /
      ACC_REWARD_SCALE;
    const debt = BigInt(positionData.rewardDebt.toString());
    const pending = accrued > debt ? accrued - debt : 0n;
    return Number(pending) / 1e9;
  }, [positionData, poolData]);

  const lockupRemainingSec = useMemo(() => {
    if (!positionData || !poolData) return 0;
    const unlockAt = Number(positionData.stakedAt) + poolData.stakeLockupSeconds;
    return Math.max(0, unlockAt - Math.floor(Date.now() / 1000));
  }, [positionData, poolData]);

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
        .stake(raw)
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
      setNotice(`Staked ${amount} $MINE`);
      return sig;
    });
  }, [program, wallet.publicKey, poolData, amount, runTx]);

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
        .unstake(positionData.stakedAmount)
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
      setNotice("Unstaked everything");
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
        Stake $MINE to earn a pro-rata share of real XNT platform revenue — funded from Mines and Wykop house edge,
        not from new token emission. Your yield rate isn't fixed or promised; it depends on total platform activity
        and how many others are staking, split fairly among everyone currently staked.
      </p>

      {!poolData && <p className="status-banner">Loading staking pool...</p>}

      {poolData && (
        <>
          <div className="panel stake-stats">
            <div className="stake-stat">
              <span className="stake-stat-label">Your stake</span>
              <span className="stake-stat-value">
                {positionData ? (Number(positionData.stakedAmount) / 1e6).toFixed(2) : "0.00"} $MINE
              </span>
            </div>
            <div className="stake-stat">
              <span className="stake-stat-label">Pending yield</span>
              <span className="stake-stat-value gold">{pendingYield.toFixed(5)} XNT</span>
            </div>
            <div className="stake-stat">
              <span className="stake-stat-label">Total staked (pool)</span>
              <span className="stake-stat-value">{(Number(poolData.totalStaked) / 1e6).toFixed(2)} $MINE</span>
            </div>
          </div>

          <div className="panel">
            <div className="controls">
              <label>
                Amount ($MINE)
                <input value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
              </label>
              <button onClick={doStake} disabled={busy || !program || !amount}>
                Stake
              </button>
            </div>

            {positionData && Number(positionData.stakedAmount) > 0 && (
              <div className="controls" style={{ marginTop: 14 }}>
                <button onClick={doClaim} disabled={busy || pendingYield <= 0} className="cashout">
                  Claim {pendingYield.toFixed(5)} XNT
                </button>
                <button onClick={doUnstake} disabled={busy || lockupRemainingSec > 0}>
                  {lockupRemainingSec > 0
                    ? `Unstake (locked ${Math.ceil(lockupRemainingSec / 3600)}h)`
                    : "Unstake all"}
                </button>
              </div>
            )}

            {notice && <p className="status-banner status-cashed_out">{notice}</p>}
            {error && <p className="error-banner">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
