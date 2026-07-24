"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { listLabels, type VaultConfig } from "@/lib/labelVault";
import { ACTIVE_NETWORK } from "@/lib/poolConfig";

function shortAddr(addr: string) {
  return addr.slice(0, 4) + "…" + addr.slice(-4);
}

export default function Labels() {
  const { connection } = useConnection();
  const [labels, setLabels] = useState<{ address: string; config: VaultConfig }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    let lastErr: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        const result = await listLabels(connection);
        setLabels(result.map((l) => ({ address: l.address.toBase58(), config: l.config })));
        setError(null);
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    setError(lastErr instanceof Error ? lastErr.message : String(lastErr));
  }, [connection]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 20000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto max-w-2xl px-4 py-4 flex items-center justify-between">
          <div>
            <div className="font-semibold">Labels</div>
            <div className="text-xs text-zinc-500 uppercase tracking-wide">{ACTIVE_NETWORK}</div>
          </div>
          <Link href="/create" className="text-sm rounded-lg bg-zinc-100 text-zinc-950 px-4 py-2 font-medium">
            + Create Label
          </Link>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-2xl px-4 py-10 space-y-4">
        {error && (
          <div className="rounded-lg border border-red-900 bg-red-950/40 text-red-300 text-sm px-4 py-3">
            {error} (retrying…)
          </div>
        )}

        {labels === null && !error && <div className="text-sm text-zinc-500">Loading…</div>}

        {labels && labels.length === 0 && (
          <div className="text-sm text-zinc-500 text-center py-10">
            No Labels yet.{" "}
            <Link href="/create" className="text-zinc-300 underline">
              Create the first one
            </Link>
            .
          </div>
        )}

        {labels?.map((l) => (
          <Link
            key={l.address}
            href={`/label/${l.address}`}
            className="block rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 hover:border-zinc-700 transition"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">
                  {l.config.name} <span className="text-zinc-500">({l.config.symbol})</span>
                </div>
                <div className="text-xs text-zinc-500 mt-0.5">{shortAddr(l.address)}</div>
              </div>
              <div className="text-xs text-zinc-500 text-right">
                {l.config.allocations.length} allocation{l.config.allocations.length !== 1 ? "s" : ""}
              </div>
            </div>
            <div className="mt-3 flex gap-2 flex-wrap">
              {l.config.allocations.map((a) => (
                <span
                  key={a.poolAddress.toBase58()}
                  className="text-xs rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-400"
                >
                  {shortAddr(a.poolAddress.toBase58())}: {(a.weightBps / 100).toFixed(0)}%
                </span>
              ))}
            </div>
          </Link>
        ))}
      </main>
    </div>
  );
}
