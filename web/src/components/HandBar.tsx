"use client";
import { getCard } from "@/game/cards";
import { CardView } from "./CardView";

export function HandBar({
  handCardIds,
  gas,
  playableCardIds,
  selectedCardId,
  onSelect,
}: {
  handCardIds: string[];
  gas: number;
  playableCardIds: Set<string>;
  selectedCardId: string | null;
  onSelect: (cardId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-[var(--text-dim)]">Ręka ({handCardIds.length}) · Gas: {gas}</div>
      <div className="scrollbar-thin flex gap-2 overflow-x-auto pb-2">
        {handCardIds.map((id, i) => {
          const card = getCard(id);
          const playable = playableCardIds.has(id);
          return (
            <div key={`${id}-${i}`} className={`shrink-0 ${playable ? "" : "opacity-50"}`}>
              <CardView card={card} size="sm" selected={selectedCardId === id} onClick={() => onSelect(id)} />
            </div>
          );
        })}
        {handCardIds.length === 0 && <span className="text-xs text-[var(--text-dim)]">Brak kart w ręce.</span>}
      </div>
    </div>
  );
}
