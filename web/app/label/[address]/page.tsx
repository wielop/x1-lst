"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import {
  buildDepositTransaction,
  buildWithdrawTransaction,
  computeLabelNav,
  findVaultConfigAddress,
  getLabelMintSupply,
  getVaultConfig,
  type VaultConfig,
} from "@/lib/labelVault";
import { ACTIVE_NETWORK } from "@/lib/poolConfig";

type Tab = "stake" | "unstake";

function fmt(n: number, dp = 4) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

function shortAddr(addr: string) {
  return addr.slice(0, 4) + "…" + addr.slice(-4);
}

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

export default function LabelPage() {
  const params = useParams<{ address: string }>();
  const vaultConfigAddress = (() => {
    try {
      return new PublicKey(params.address);
    } catch {
      return null;
    }
  })();

  const { connection } = useConnection();
  const { publicKey, connected, sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [tab, setTab] = useState<Tab>("stake");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const [config, setConfig] = useState<VaultConfig | null>(null);
  const [navLamports, setNavLamports] = useState<number | null>(null);
  const [labelSupply, setLabelSupply] = useState<number | null>(null);
  const [walletXnt, setWalletXnt] = useState<number | null>(null);
  const [walletLabel, setWalletLabel] = useState<number | null>(null);

  const refreshLabel = useCallback(async () => {
    if (!vaultConfigAddress) return;
    try {
      const cfg = await withRetry(() => getVaultConfig(connection, vaultConfigAddress));
      if (!cfg) return;
      setConfig(cfg);
      const [{ navLamports: nav }, supply] = await Promise.all([
        withRetry(() => computeLabelNav(connection, cfg)),
        withRetry(() => getLabelMintSupply(connection, cfg.labelMint)),
      ]);
      setNavLamports(Number(nav));
      setLabelSupply(Number(supply));
    } catch {
      // next poll retries
    }
  }, [connection, vaultConfigAddress]);

  const refreshWallet = useCallback(async () => {
    if (!publicKey || !config) {
      setWalletXnt(null);
      setWalletLabel(null);
      return;
    }
    try {
      const lamports = await withRetry(() => connection.getBalance(publicKey, "confirmed"));
      setWalletXnt(lamports / LAMPORTS_PER_SOL);
    } catch {
      // ignore
    }
    try {
      const ata = getAssociatedTokenAddressSync(config.labelMint, publicKey);
      const account = await withRetry(() => getAccount(connection, ata));
      setWalletLabel(Number(account.amount) / LAMPORTS_PER_SOL);
    } catch {
      setWalletLabel(0);
    }
  }, [connection, publicKey, config]);

  useEffect(() => {
    void refreshLabel();
    const id = setInterval(() => void refreshLabel(), 20000);
    return () => clearInterval(id);
  }, [refreshLabel]);

  useEffect(() => {
    void refreshWallet();
    const id = setInterval(() => void refreshWallet(), 20000);
    return () => clearInterval(id);
  }, [refreshWallet]);

  const exchangeRate =
    navLamports !== null && labelSupply !== null && labelSupply > 0
      ? navLamports / labelSupply
      : 1;
  const navXnt = navLamports !== null ? navLamports / LAMPORTS_PER_SOL : null;

  const handleSubmit = useCallback(async () => {
    if (!vaultConfigAddress) return;
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
      if (tab === "stake") {
        const lamports = BigInt(Math.round(value * LAMPORTS_PER_SOL));
        ({ instructions } = await buildDepositTransaction(connection, publicKey, vaultConfigAddress, lamports));
      } else {
        const tokens = BigInt(Math.round(value * LAMPORTS_PER_SOL));
        ({ instructions } = await buildWithdrawTransaction(connection, publicKey, vaultConfigAddress, tokens));
      }

      const tx = new Transaction().add(...instructions);
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      const signature = await sendTransaction(tx, connection);
      setStatus(`Submitted: ${signature.slice(0, 8)}… waiting for confirmation`);
      await connection.confirmTransaction(signature, "confirmed");
      setStatus(
        tab === "stake"
          ? `Deposited ${value} XNT. Signature ${signature.slice(0, 8)}…`
          : `Withdrew ${value} label tokens. Signature ${signature.slice(0, 8)}…`,
      );
      setAmount("");
      void refreshLabel();
      void refreshWallet();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [amount, connection, publicKey, sendTransaction, setVisible, tab, vaultConfigAddress, refreshLabel, refreshWallet]);

  if (!vaultConfigAddress) {
    return (
      <div className="min-h-full flex items-center justify-center bg-zinc-950 text-zinc-100">
        <div className="text-sm text-red-400">Invalid label address</div>
      </div>
    );
  }

  return (
    <div className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto max-w-2xl px-4 py-4 flex items-center justify-between">
          <div>
            <div className="font-semibold">{config ? `${config.name} (${config.symbol})` : "Label"}</div>
            <div className="text-xs text-zinc-500 uppercase tracking-wide">{ACTIVE_NETWORK}</div>
          </div>
          <Link href="/labels" className="text-sm text-zinc-400 hover:text-zinc-100">
            ← All Labels
          </Link>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-2xl px-4 py-10 space-y-6">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="NAV" value={navXnt !== null ? `${fmt(navXnt, 2)} XNT` : "—"} />
          <Stat label="Exchange rate" value={`1 ${config?.symbol ?? "share"} = ${fmt(exchangeRate, 6)} XNT`} />
          <Stat label="Allocations" value={config ? String(config.allocations.length) : "—"} />
        </div>

        {config && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="text-xs text-zinc-500 mb-2">Basket composition</div>
            <div className="flex gap-2 flex-wrap">
              {config.allocations.map((a) => (
                <span
                  key={a.poolAddress.toBase58()}
                  className="text-xs rounded-full border border-zinc-700 px-2 py-1 text-zinc-400"
                >
                  {shortAddr(a.poolAddress.toBase58())}: {(a.weightBps / 100).toFixed(0)}%
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 space-y-4">
          <div className="flex gap-2">
            <button
              onClick={() => setTab("stake")}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${tab === "stake" ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 text-zinc-400"}`}
            >
              Deposit
            </button>
            <button
              onClick={() => setTab("unstake")}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${tab === "unstake" ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 text-zinc-400"}`}
            >
              Withdraw
            </button>
          </div>

          <div>
            <div className="flex justify-between text-xs text-zinc-500 mb-1">
              <span>{tab === "stake" ? "Amount (XNT)" : `Amount (${config?.symbol ?? "shares"})`}</span>
              <span>
                Balance:{" "}
                {tab === "stake"
                  ? walletXnt !== null
                    ? `${fmt(walletXnt)} XNT`
                    : "—"
                  : walletLabel !== null
                    ? `${fmt(walletLabel)} ${config?.symbol ?? ""}`
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
                  ? "Deposit"
                  : "Withdraw"}
          </button>

          {status && <div className="text-sm text-zinc-400 break-all">{status}</div>}
        </div>

        <p className="text-xs text-zinc-600 text-center">
          Label {shortAddr(vaultConfigAddress.toBase58())} — testnet only, not audited.
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
