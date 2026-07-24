"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { stakePoolInfo } from "@/lib/stake-pool";
import { POOL_CONFIG, ACTIVE_NETWORK } from "@/lib/poolConfig";
import type { ValidatorCandidate } from "@/lib/validatorSelection";

function fmt(n: number, dp = 4) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

function shortAddr(addr: string) {
  return addr.slice(0, 4) + "…" + addr.slice(-4);
}

interface PoolStakeAccount {
  voteAccountAddress: string;
  validatorActiveStakeLamports: string;
  validatorTransientStakeLamports: string;
  updateRequired: boolean;
}

interface PoolData {
  totalLamports: string;
  poolTokenSupply: string;
  lastUpdateEpoch: string;
  maxValidators: number;
  currentValidators: number;
  stakeAccounts: PoolStakeAccount[];
  epochFeeNum: string;
  epochFeeDenom: string;
  withdrawalFeeNum: string;
  withdrawalFeeDenom: string;
}

interface ValidatorsResponse {
  params: { maxCommission: number; minStakeXnt: number; minCreditRatio: number; limit: number };
  candidateCount: number;
  survivors: ValidatorCandidate[];
  candidates: ValidatorCandidate[];
  error?: string;
}

export default function Dashboard() {
  const [pool, setPool] = useState<PoolData | null>(null);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [validators, setValidators] = useState<ValidatorsResponse | null>(null);
  const [showAllCandidates, setShowAllCandidates] = useState(false);

  const refreshPool = useCallback(async () => {
    try {
      const connection = new Connection(POOL_CONFIG.rpcUrl, "confirmed");
      const info = await stakePoolInfo(connection, POOL_CONFIG.poolAddress);
      setPool({
        totalLamports: info.totalLamports,
        poolTokenSupply: info.poolTokenSupply,
        lastUpdateEpoch: info.lastUpdateEpoch,
        maxValidators: info.details.maxNumberOfValidators,
        currentValidators: info.details.currentNumberOfValidators,
        stakeAccounts: info.details.stakeAccounts,
        epochFeeNum: info.epochFee.numerator.toString(),
        epochFeeDenom: info.epochFee.denominator.toString(),
        withdrawalFeeNum: info.stakeWithdrawalFee.numerator.toString(),
        withdrawalFeeDenom: info.stakeWithdrawalFee.denominator.toString(),
      });
      setPoolError(null);
    } catch (e) {
      setPoolError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshValidators = useCallback(async () => {
    try {
      const res = await fetch("/api/validators");
      const json = await res.json();
      setValidators(json);
    } catch {
      // next poll retries
    }
  }, []);

  useEffect(() => {
    void refreshPool();
    void refreshValidators();
    const id = setInterval(() => {
      void refreshPool();
      void refreshValidators();
    }, 30000);
    return () => clearInterval(id);
  }, [refreshPool, refreshValidators]);

  const tvlXnt = pool ? Number(pool.totalLamports) / LAMPORTS_PER_SOL : null;
  const exchangeRate =
    pool && Number(pool.poolTokenSupply) > 0
      ? Number(pool.totalLamports) / Number(pool.poolTokenSupply)
      : null;

  return (
    <div className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto max-w-4xl px-4 py-4 flex items-center justify-between">
          <div>
            <div className="font-semibold">X1 Liquid Staking — Dashboard</div>
            <div className="text-xs text-zinc-500 uppercase tracking-wide">{ACTIVE_NETWORK}</div>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/labels" className="text-sm text-zinc-400 hover:text-zinc-100">
              Labels
            </Link>
            <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-100">
              ← Stake / Unstake
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-4xl px-4 py-10 space-y-8">
        {poolError && (
          <div className="rounded-lg border border-red-900 bg-red-950/40 text-red-300 text-sm px-4 py-3">
            Pool data unavailable right now: {poolError} (X1 testnet RPC is occasionally flaky —
            retrying every 30s)
          </div>
        )}

        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="TVL" value={tvlXnt !== null ? `${fmt(tvlXnt, 2)} XNT` : "—"} />
          <Stat
            label="Exchange rate"
            value={exchangeRate !== null ? `1 LST = ${fmt(exchangeRate, 6)} XNT` : "—"}
          />
          <Stat
            label="Validators in pool"
            value={pool ? `${pool.currentValidators} / ${pool.maxValidators}` : "—"}
          />
          <Stat label="Last update epoch" value={pool ? pool.lastUpdateEpoch : "—"} />
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
          <h2 className="font-medium mb-4">Validators delegated by the pool</h2>
          {pool && pool.stakeAccounts.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="text-zinc-500 text-left">
                <tr>
                  <th className="font-normal pb-2">Vote account</th>
                  <th className="font-normal pb-2 text-right">Active stake</th>
                  <th className="font-normal pb-2 text-right">Transient</th>
                  <th className="font-normal pb-2 text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {pool.stakeAccounts.map((s) => (
                  <tr key={s.voteAccountAddress} className="border-t border-zinc-800">
                    <td className="py-2">{shortAddr(s.voteAccountAddress)}</td>
                    <td className="py-2 text-right">
                      {fmt(Number(s.validatorActiveStakeLamports) / LAMPORTS_PER_SOL, 2)} XNT
                    </td>
                    <td className="py-2 text-right">
                      {fmt(Number(s.validatorTransientStakeLamports) / LAMPORTS_PER_SOL, 2)} XNT
                    </td>
                    <td className="py-2 text-right">
                      {s.updateRequired ? (
                        <span className="text-amber-400">update pending</span>
                      ) : (
                        <span className="text-emerald-400">current</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-sm text-zinc-500">
              {pool ? "No validators delegated yet." : "Loading…"}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-medium">Validator selection methodology</h2>
            {validators && (
              <span className="text-xs text-zinc-500">
                {validators.survivors.length} qualify of {validators.candidateCount} on network
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mb-4">
            Filters: commission ≤ {validators?.params.maxCommission ?? "…"}%, stake ≥{" "}
            {validators?.params.minStakeXnt ?? "…"} XNT, not delinquent, vote credits ≥{" "}
            {validators?.params.minCreditRatio ?? "…"}x network median, common software version.
            Ranked by stake, top {validators?.params.limit ?? "…"} kept. This is a read-only
            report — adding validators to the pool is a separate operator action, not exposed
            here.
          </p>

          {validators?.error && (
            <div className="text-sm text-red-400 mb-3">{validators.error}</div>
          )}

          {validators && (
            <>
              <table className="w-full text-sm">
                <thead className="text-zinc-500 text-left">
                  <tr>
                    <th className="font-normal pb-2">#</th>
                    <th className="font-normal pb-2">Vote account</th>
                    <th className="font-normal pb-2 text-right">Stake</th>
                    <th className="font-normal pb-2 text-right">Commission</th>
                    <th className="font-normal pb-2">Version</th>
                  </tr>
                </thead>
                <tbody>
                  {validators.survivors.map((v, i) => (
                    <tr key={v.votePubkey} className="border-t border-zinc-800">
                      <td className="py-2 text-zinc-500">{i + 1}</td>
                      <td className="py-2">{shortAddr(v.votePubkey)}</td>
                      <td className="py-2 text-right">{fmt(v.activatedStakeXnt, 0)} XNT</td>
                      <td className="py-2 text-right">{v.commission}%</td>
                      <td className="py-2 text-zinc-500">{v.version ?? "unknown"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <button
                onClick={() => setShowAllCandidates((v) => !v)}
                className="mt-4 text-xs text-zinc-500 hover:text-zinc-300"
              >
                {showAllCandidates ? "Hide" : "Show"} excluded candidates (
                {validators.candidates.filter((c) => c.excluded).length})
              </button>

              {showAllCandidates && (
                <table className="w-full text-sm mt-3">
                  <thead className="text-zinc-500 text-left">
                    <tr>
                      <th className="font-normal pb-2">Vote account</th>
                      <th className="font-normal pb-2">Reason excluded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validators.candidates
                      .filter((c) => c.excluded)
                      .map((c) => (
                        <tr key={c.votePubkey} className="border-t border-zinc-800">
                          <td className="py-2">{shortAddr(c.votePubkey)}</td>
                          <td className="py-2 text-zinc-500">{c.reason}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </section>

        <p className="text-xs text-zinc-600 text-center">
          Program {POOL_CONFIG.programId.toBase58().slice(0, 8)}… · Pool{" "}
          {POOL_CONFIG.poolAddress.toBase58().slice(0, 8)}… — testnet only, not audited.
        </p>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 py-3 px-2 text-center">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-sm font-medium mt-1 truncate">{value}</div>
    </div>
  );
}
