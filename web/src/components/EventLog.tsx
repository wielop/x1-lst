"use client";
import { useState } from "react";
import type { GameEvent } from "@/game/types";

export function EventLog({ events }: { events: GameEvent[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-[var(--border)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-2 py-1 text-xs font-semibold"
      >
        <span>Historia zdarzeń ({events.length})</span>
        <span>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="scrollbar-thin max-h-40 overflow-y-auto border-t border-[var(--border)] p-2 text-[11px]">
          {events.map((e, i) => (
            <div key={i} className="text-[var(--text-dim)]">
              <span className="text-white/60">R{e.round}</span> {e.message}
            </div>
          ))}
          {events.length === 0 && <span>Brak zdarzeń.</span>}
        </div>
      )}
    </div>
  );
}
