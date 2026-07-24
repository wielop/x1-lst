"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { depositSol, withdrawSol, stakePoolInfo } from "@/lib/stake-pool";
import { POOL_CONFIG, ACTIVE_NETWORK } from "@/lib/poolConfig";

type Tab = "stake" | "unstake";

function fmt(n: number, dp = 4) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

// X1 testnet's public RPC load-balances across nodes with inconsistent state,
// so reads occasionally 404 transiently even on accounts that definitely exist.
async function withRetry<T>(fn: () => Promise<T>, attempts = 6, delayMs = 1500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export default function Home() {
  const { connection } = useConnection();
  const { publicKey, connected, sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [tab, setTab] = useState<Tab>("stake");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const [walletSol, setWalletSol] = useState<number | null>(null);
  const [walletLst, setWalletLst] = useState<number | null>(null);
  const [pool, setPool] = useState<{
    totalLamports: string;
    poolTokenSupply: string;
    validators: number;
  } | null>(null);

  const refreshPool = useCallback(async () => {
    try {
      const info = await withRetry(() => stakePoolInfo(connection, POOL_CONFIG.poolAddress));
      setPool({
        totalLamports: info.totalLamports,
        poolTokenSupply: info.poolTokenSupply,
        validators: info.details.currentNumberOfValidators,
      });
    } catch {
      // gave up after retries; next 15s poll tries again
    }
  }, [connection]);

  const refreshWallet = useCallback(async () => {
    if (!publicKey) {
      setWalletSol(null);
      setWalletLst(null);
      return;
    }
    try {
      const lamports = await withRetry(() => connection.getBalance(publicKey, "confirmed"));
      setWalletSol(lamports / LAMPORTS_PER_SOL);
    } catch {
      // ignore transient RPC error
    }
    try {
      const ata = getAssociatedTokenAddressSync(POOL_CONFIG.poolMint, publicKey);
      const account = await withRetry(() => getAccount(connection, ata));
      setWalletLst(Number(account.amount) / LAMPORTS_PER_SOL);
    } catch {
      setWalletLst(0);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void refreshPool();
    const id = setInterval(() => void refreshPool(), 15000);
    return () => clearInterval(id);
  }, [refreshPool]);

  useEffect(() => {
    void refreshWallet();
    const id = setInterval(() => void refreshWallet(), 15000);
    return () => clearInterval(id);
  }, [refreshWallet]);

  const exchangeRate =
    pool && Number(pool.poolTokenSupply) > 0
      ? Number(pool.totalLamports) / Number(pool.poolTokenSupply)
      : 1;

  const tvlSol = pool ? Number(pool.totalLamports) / LAMPORTS_PER_SOL : null;

  const handleSubmit = useCallback(async () => {
    if (!publicKey) {
      setVisible(true);
      return;
    }
    const value = Number(amount.replace(",", "."));
    if (!value || value <= 0) {
      setStatus("Enter an amount greater than 0");
      return;
    }

    setBusy(true);
    setStatus(null);
    try {
      let instructions;
      let signers;
      if (tab === "stake") {
        const lamports = Math.round(value * LAMPORTS_PER_SOL);
        ({ instructions, signers } = await depositSol(
          connection,
          POOL_CONFIG.poolAddress,
          publicKey,
          lamports,
        ));
      } else {
        ({ instructions, signers } = await withdrawSol(
          connection,
          POOL_CONFIG.poolAddress,
          publicKey,
          publicKey,
          value,
        ));
      }

      const tx = new Transaction().add(...instructions);
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      if (signers.length > 0) {
        tx.partialSign(...signers);
      }

      const signature = await sendTransaction(tx, connection, {
        signers: signers.length > 0 ? signers : undefined,
      });
      setStatus(`Submitted: ${signature.slice(0, 8)}… waiting for confirmation`);

      await connection.confirmTransaction(signature, "confirmed");
      setStatus(
        tab === "stake"
          ? `Staked ${value} XNT. Signature ${signature.slice(0, 8)}…`
          : `Unstaked ${value} pool tokens. Signature ${signature.slice(0, 8)}…`,
      );
      setAmount("");
      void refreshPool();
      void refreshWallet();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [
    amount,
    connection,
    publicKey,
    sendTransaction,
    setVisible,
    tab,
    refreshPool,
    refreshWallet,
  ]);

  return (
    <div className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto max-w-2xl px-4 py-4 flex items-center justify-between">
          <div>
            <div className="font-semibold">X1 Liquid Staking</div>
            <div className="text-xs text-zinc-500 uppercase tracking-wide">{ACTIVE_NETWORK}</div>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/labels" className="text-sm text-zinc-400 hover:text-zinc-100">
              Labels
            </Link>
            <Link href="/dashboard" className="text-sm text-zinc-400 hover:text-zinc-100">
              Dashboard
            </Link>
            <Link href="/docs" className="text-sm text-zinc-400 hover:text-zinc-100">
              Docs
            </Link>
            <WalletButton />
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-2xl px-4 py-10 space-y-6">
        <div className="grid grid-cols-3 gap-3 text-center">
          <Stat label="TVL" value={tvlSol !== null ? `${fmt(tvlSol, 2)} XNT` : "—"} />
          <Stat label="Exchange rate" value={`1 LST = ${fmt(exchangeRate, 6)} XNT`} />
          <Stat label="Validators" value={pool ? String(pool.validators) : "—"} />
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 space-y-4">
          <div className="flex gap-2">
            <TabButton active={tab === "stake"} onClick={() => setTab("stake")}>
              Stake
            </TabButton>
            <TabButton active={tab === "unstake"} onClick={() => setTab("unstake")}>
              Unstake
            </TabButton>
          </div>

          <div>
            <div className="flex justify-between text-xs text-zinc-500 mb-1">
              <span>{tab === "stake" ? "Amount (XNT)" : "Amount (pool tokens)"}</span>
              <span>
                Balance:{" "}
                {tab === "stake"
                  ? walletSol !== null
                    ? `${fmt(walletSol)} XNT`
                    : "—"
                  : walletLst !== null
                    ? `${fmt(walletLst)} LST`
                    : "—"}
              </span>
            </div>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0.0"
              className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-3 text-lg outline-none focus:border-zinc-600"
            />
          </div>

          <button
            onClick={handleSubmit}
            disabled={busy}
            className="w-full rounded-lg bg-zinc-100 text-zinc-950 font-medium py-3 disabled:opacity-50"
          >
            {!connected
              ? "Connect wallet"
              : busy
                ? "Submitting…"
                : tab === "stake"
                  ? "Stake XNT"
                  : "Unstake"}
          </button>

          {status && <div className="text-sm text-zinc-400 break-all">{status}</div>}
        </div>

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
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-sm font-medium mt-1">{value}</div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
        active ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 text-zinc-400"
      }`}
    >
      {children}
    </button>
  );
}

function WalletButton() {
  const { publicKey, disconnect } = useWallet();
  const { setVisible } = useWalletModal();

  if (!publicKey) {
    return (
      <button
        onClick={() => setVisible(true)}
        className="rounded-lg bg-zinc-100 text-zinc-950 text-sm font-medium px-4 py-2"
      >
        Connect
      </button>
    );
  }

  const addr = publicKey.toBase58();
  return (
    <button
      onClick={() => void disconnect()}
      className="rounded-lg border border-zinc-700 text-sm px-4 py-2"
    >
      {addr.slice(0, 4)}…{addr.slice(-4)}
    </button>
  );
}
