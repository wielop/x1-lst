"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Transaction } from "@solana/web3.js";
import { buildCreateLabelTransactions } from "@/lib/labelVault";
import { AVAILABLE_POOLS } from "@/lib/labelVaultConfig";
import { ACTIVE_NETWORK } from "@/lib/poolConfig";

type Step = "metadata" | "allocations" | "review" | "done";

export default function CreateLabel() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [step, setStep] = useState<Step>("metadata");
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [weights, setWeights] = useState<number[]>(AVAILABLE_POOLS.map(() => 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultMint, setResultMint] = useState<string | null>(null);

  const weightSum = useMemo(() => weights.reduce((a, b) => a + b, 0), [weights]);

  const setWeight = useCallback((i: number, pct: number) => {
    setWeights((w) => w.map((v, idx) => (idx === i ? Math.max(0, Math.min(100, pct)) : v)));
  }, []);

  const splitEvenly = useCallback(() => {
    const n = AVAILABLE_POOLS.length;
    const base = Math.floor(100 / n);
    const rem = 100 - base * n;
    setWeights(AVAILABLE_POOLS.map((_, i) => base + (i < rem ? 1 : 0)));
  }, []);

  const handleCreate = useCallback(async () => {
    if (!publicKey) {
      setVisible(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const allocationTargets = AVAILABLE_POOLS.map((p, i) => ({
        poolAddress: p.address,
        weightBps: Math.round(weights[i] * 100),
      })).filter((a) => a.weightBps > 0);

      const { setupInstructions, createLabelInstructions, signers, labelMint } =
        await buildCreateLabelTransactions(connection, publicKey, name, symbol, allocationTargets);

      const { blockhash: bh1 } = await connection.getLatestBlockhash("confirmed");
      const setupTx = new Transaction().add(...setupInstructions);
      setupTx.recentBlockhash = bh1;
      setupTx.feePayer = publicKey;
      setupTx.partialSign(...signers);
      const setupSig = await sendTransaction(setupTx, connection, { signers });
      await connection.confirmTransaction(setupSig, "confirmed");

      const { blockhash: bh2 } = await connection.getLatestBlockhash("confirmed");
      const createTx = new Transaction().add(...createLabelInstructions);
      createTx.recentBlockhash = bh2;
      createTx.feePayer = publicKey;
      const createSig = await sendTransaction(createTx, connection);
      await connection.confirmTransaction(createSig, "confirmed");

      setResultMint(labelMint.toBase58());
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [connection, name, publicKey, sendTransaction, setVisible, symbol, weights]);

  return (
    <div className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto max-w-2xl px-4 py-4 flex items-center justify-between">
          <div>
            <div className="font-semibold">Create a Label</div>
            <div className="text-xs text-zinc-500 uppercase tracking-wide">{ACTIVE_NETWORK}</div>
          </div>
          <Link href="/labels" className="text-sm text-zinc-400 hover:text-zinc-100">
            Browse Labels
          </Link>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-2xl px-4 py-10">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 space-y-5">
          {step === "metadata" && (
            <>
              <h2 className="font-medium">Create a Label</h2>
              <p className="text-xs text-zinc-500">
                A Label is your own basket vault — deposits split across the underlying LSTs you
                choose next, and mint one token representing the blended position.
              </p>
              <Field label="Label Symbol (e.g. youXNT)">
                <input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.slice(0, 10))}
                  placeholder="youXNT"
                  className="input"
                />
              </Field>
              <Field label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 32))}
                  placeholder="Label name"
                  className="input"
                />
              </Field>
              <Field label="Description (optional)">
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value.slice(0, 64))}
                  placeholder="Description (max 64 characters, display-only for now)"
                  className="input"
                />
              </Field>
              <div className="flex justify-end gap-3 pt-2">
                <Link href="/" className="btn-secondary">
                  Cancel
                </Link>
                <button
                  disabled={!symbol || !name}
                  onClick={() => setStep("allocations")}
                  className="btn-primary"
                >
                  Next →
                </button>
              </div>
            </>
          )}

          {step === "allocations" && (
            <>
              <h2 className="font-medium">Choose allocations</h2>
              <p className="text-xs text-zinc-500">
                Split deposits across underlying pools by weight — must sum to 100%.
              </p>
              {AVAILABLE_POOLS.map((p, i) => (
                <div key={p.address.toBase58()} className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm">{p.label}</div>
                    <div className="text-xs text-zinc-500">{p.address.toBase58().slice(0, 8)}…</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={weights[i]}
                      onChange={(e) => setWeight(i, Number(e.target.value))}
                      className="input w-20 text-right"
                    />
                    <span className="text-sm text-zinc-500">%</span>
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between text-xs pt-1">
                <button onClick={splitEvenly} className="text-zinc-500 hover:text-zinc-300">
                  Split evenly
                </button>
                <span className={weightSum === 100 ? "text-emerald-400" : "text-amber-400"}>
                  Total: {weightSum}%
                </span>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button onClick={() => setStep("metadata")} className="btn-secondary">
                  Back
                </button>
                <button
                  disabled={weightSum !== 100}
                  onClick={() => setStep("review")}
                  className="btn-primary"
                >
                  Next →
                </button>
              </div>
            </>
          )}

          {step === "review" && (
            <>
              <h2 className="font-medium">Review & Create</h2>
              <div className="text-sm space-y-1">
                <Row k="Symbol" v={symbol} />
                <Row k="Name" v={name} />
                {description && <Row k="Description" v={description} />}
                {AVAILABLE_POOLS.map((p, i) =>
                  weights[i] > 0 ? <Row key={p.address.toBase58()} k={p.label} v={`${weights[i]}%`} /> : null,
                )}
              </div>
              {error && <div className="text-sm text-red-400 break-all">{error}</div>}
              <div className="flex justify-end gap-3 pt-2">
                <button onClick={() => setStep("allocations")} className="btn-secondary">
                  Back
                </button>
                <button onClick={handleCreate} disabled={busy} className="btn-primary">
                  {!publicKey ? "Connect wallet" : busy ? "Creating…" : "Create Label"}
                </button>
              </div>
            </>
          )}

          {step === "done" && resultMint && (
            <>
              <h2 className="font-medium text-emerald-400">Label created</h2>
              <p className="text-sm text-zinc-400">
                Mint: <span className="break-all">{resultMint}</span>
              </p>
              <div className="flex justify-end pt-2">
                <Link href="/labels" className="btn-primary">
                  View Labels →
                </Link>
              </div>
            </>
          )}
        </div>

        <p className="text-xs text-zinc-600 text-center mt-6">
          Testnet only, not audited. Underlying allocations are read live from each pool's own
          on-chain account — never trusted from this form.
        </p>
      </main>

      <style jsx global>{`
        .input {
          background: #09090b;
          border: 1px solid #27272a;
          border-radius: 0.5rem;
          padding: 0.5rem 0.75rem;
          color: #f4f4f5;
          outline: none;
          width: 100%;
        }
        .input:focus {
          border-color: #52525b;
        }
        .btn-primary {
          background: #f4f4f5;
          color: #09090b;
          font-weight: 500;
          padding: 0.5rem 1.25rem;
          border-radius: 0.5rem;
        }
        .btn-primary:disabled {
          opacity: 0.5;
        }
        .btn-secondary {
          border: 1px solid #3f3f46;
          color: #d4d4d8;
          padding: 0.5rem 1.25rem;
          border-radius: 0.5rem;
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-zinc-800 py-1.5">
      <span className="text-zinc-500">{k}</span>
      <span>{v}</span>
    </div>
  );
}
