"use client";
import { getCard } from "@/game/cards";
import type { Unit } from "@/game/types";
import { factionTheme } from "@/lib/factionTheme";

export function UnitChip({
  unit,
  onClick,
  selectable,
  selected,
  isTarget,
}: {
  unit: Unit;
  onClick?: () => void;
  selectable?: boolean;
  selected?: boolean;
  isTarget?: boolean;
}) {
  const card = getCard(unit.cardId);
  const theme = factionTheme(card.faction);
  const statuses: string[] = [];
  if (unit.shield) statuses.push("🛡");
  if (unit.poison > 0) statuses.push(`☠${unit.poison}`);
  if (unit.overload > 0) statuses.push(`⏳${unit.overload}`);
  if (unit.frozen) statuses.push("❄");
  if (unit.keywords.has("GUARD")) statuses.push("Ⓖ");

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={`${card.name} — ${card.text}`}
      className={`flex w-16 flex-col items-center rounded-md border p-1 text-[10px] transition ${
        selected ? "ring-2 ring-white" : ""
      } ${isTarget ? "ring-2 ring-red-400 animate-pulse" : ""} ${selectable ? "cursor-pointer hover:scale-105" : onClick ? "cursor-pointer" : ""}`}
      style={{ borderColor: theme.color, background: theme.bg }}
    >
      <span className="w-full truncate font-semibold" style={{ color: theme.color }}>
        {card.name}
      </span>
      <span className="flex gap-1 font-bold">
        <span className="text-red-400">{unit.atk}</span>/<span className="text-green-400">{unit.hp}</span>
      </span>
      {statuses.length > 0 && <span>{statuses.join(" ")}</span>}
    </button>
  );
}
