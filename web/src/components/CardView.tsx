"use client";
import { useState } from "react";
import type { Card } from "@/game/types";
import { factionTheme } from "@/lib/factionTheme";

const TYPE_LABEL: Record<Card["type"], string> = {
  UNIT: "Jednostka",
  ACTION: "Akcja",
  STRUCTURE: "Struktura",
};

const RARITY_LABEL: Record<Card["rarity"], string> = {
  BASIC: "Basic",
  COMMON: "Common",
  UNCOMMON: "Uncommon",
  RARE: "Rare",
  EPIC: "Epic",
  LEGENDARY: "Legendary",
};

export function CardView({
  card,
  size = "md",
  onClick,
  selected,
  disabled,
  badge,
}: {
  card: Card;
  size?: "sm" | "md" | "lg";
  onClick?: () => void;
  selected?: boolean;
  disabled?: boolean;
  badge?: string | number;
}) {
  const theme = factionTheme(card.faction);
  const dims = size === "sm" ? "w-20 h-28 text-[10px]" : size === "lg" ? "w-40 h-56 text-sm" : "w-28 h-40 text-xs";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      aria-label={`${card.name}, koszt ${card.cost}`}
      className={`relative flex flex-col justify-between rounded-lg border-2 p-1.5 text-left transition-transform ${dims} ${
        selected ? "ring-2 ring-white scale-105" : ""
      } ${disabled ? "opacity-40 cursor-not-allowed" : onClick ? "cursor-pointer hover:scale-105" : "cursor-default"}`}
      style={{ borderColor: theme.color, background: theme.bg, color: "var(--text)" }}
    >
      <div className="flex items-start justify-between">
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-bold"
          style={{ background: theme.color, color: "#0b0e14" }}
        >
          {card.cost}
        </span>
        <span title={theme.label} style={{ color: theme.color }}>
          {theme.symbol}
        </span>
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="font-semibold leading-tight">{card.name}</div>
        <div className="mt-0.5 line-clamp-3 opacity-80">{card.text}</div>
      </div>
      <div className="flex items-center justify-between font-bold">
        <span>{card.type === "ACTION" ? TYPE_LABEL.ACTION : ""}</span>
        {card.atk !== null && card.hp !== null && (
          <span className="ml-auto flex gap-1">
            <span className="text-red-400">{card.atk}</span>/<span className="text-green-400">{card.hp}</span>
          </span>
        )}
        {card.atk === null && card.hp !== null && <span className="ml-auto text-green-400">{card.hp} HP</span>}
      </div>
      {badge !== undefined && (
        <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white text-[10px] font-bold text-black">
          {badge}
        </span>
      )}
    </button>
  );
}

export function CardDetailPopover({ card, onClose }: { card: Card; onClose: () => void }) {
  const theme = factionTheme(card.faction);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-xl border-2 p-4"
        style={{ borderColor: theme.color, background: "var(--bg-panel)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">{card.name}</h3>
          <button onClick={onClose} className="rounded px-2 py-1 text-sm opacity-70 hover:opacity-100" aria-label="Zamknij">
            ✕
          </button>
        </div>
        <div className="mt-1 flex flex-wrap gap-2 text-xs opacity-80">
          <span style={{ color: theme.color }}>
            {theme.symbol} {theme.label}
          </span>
          <span>· {TYPE_LABEL[card.type]}</span>
          <span>· {RARITY_LABEL[card.rarity]}</span>
          <span>· Koszt {card.cost}</span>
          {card.atk !== null && <span>· ATK {card.atk}</span>}
          {card.hp !== null && <span>· HP {card.hp}</span>}
        </div>
        {card.keywords.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {card.keywords.map((k) => (
              <span key={k} className="rounded bg-white/10 px-2 py-0.5 text-[11px] font-semibold">
                {k}
              </span>
            ))}
          </div>
        )}
        <p className="mt-3 text-sm leading-relaxed">{card.text}</p>
      </div>
    </div>
  );
}

export function CardWithDetail(props: { card: Card; size?: "sm" | "md" | "lg"; selected?: boolean; badge?: string | number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <CardView {...props} onClick={() => setOpen(true)} />
      {open && <CardDetailPopover card={props.card} onClose={() => setOpen(false)} />}
    </>
  );
}
