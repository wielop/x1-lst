"use client";
import { useMemo, useState, useEffect } from "react";
import Link from "next/link";
import { CARDS, CARDS_BY_ID } from "@/game/cards";
import { FACTIONS, validateDeck } from "@/game/decks";
import { MAX_COPIES_LEGENDARY, MAX_COPIES_NORMAL, DECK_SIZE } from "@/game/constants";
import type { Faction } from "@/game/types";
import { CardView, CardDetailPopover } from "@/components/CardView";
import { factionTheme } from "@/lib/factionTheme";
import { loadSavedDecks, saveDeck, deleteDeck, type SavedDeck } from "@/lib/storage";
import { trackEvent } from "@/lib/storage";

export default function DeckBuilderPage() {
  const [faction, setFaction] = useState<Faction>("MINERS");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [detailCard, setDetailCard] = useState<string | null>(null);
  const [deckName, setDeckName] = useState("Moja talia");
  const [saved, setSaved] = useState<SavedDeck[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  // See src/app/play/page.tsx for why this documented suppression is here: hydrating
  // client-only localStorage state on mount, flagged by the new experimental
  // react-hooks/set-state-in-effect rule despite being a one-shot, non-cascading read.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSaved(loadSavedDecks().decks);
  }, []);

  const poolCards = useMemo(
    () => CARDS.filter((c) => c.faction === faction || c.faction === "NEUTRAL"),
    [faction]
  );

  const cardIds = useMemo(() => {
    const ids: string[] = [];
    for (const [id, n] of Object.entries(counts)) for (let i = 0; i < n; i++) ids.push(id);
    return ids;
  }, [counts]);

  const validation = useMemo(() => validateDeck(cardIds), [cardIds]);

  const curve = useMemo(() => {
    const buckets = new Array(8).fill(0); // costs 0..6, 7+ merged into index7
    for (const id of cardIds) {
      const c = CARDS_BY_ID[id].cost;
      buckets[Math.min(c, 7)]++;
    }
    return buckets;
  }, [cardIds]);

  const typeCounts = useMemo(() => {
    const t = { UNIT: 0, ACTION: 0, STRUCTURE: 0 };
    for (const id of cardIds) t[CARDS_BY_ID[id].type]++;
    return t;
  }, [cardIds]);

  function addCard(id: string) {
    const card = CARDS_BY_ID[id];
    const max = card.rarity === "LEGENDARY" ? MAX_COPIES_LEGENDARY : MAX_COPIES_NORMAL;
    setCounts((prev) => {
      const cur = prev[id] ?? 0;
      if (cur >= max) return prev;
      if (cardIds.length >= DECK_SIZE) return prev;
      return { ...prev, [id]: cur + 1 };
    });
  }

  function removeCard(id: string) {
    setCounts((prev) => {
      const cur = prev[id] ?? 0;
      if (cur <= 0) return prev;
      const next = { ...prev, [id]: cur - 1 };
      if (next[id] === 0) delete next[id];
      return next;
    });
  }

  function handleSave() {
    if (!validation.valid) {
      setMessage("Popraw błędy talii przed zapisem.");
      return;
    }
    const d = saveDeck({ name: deckName || "Talia bez nazwy", faction, cardIds });
    setSaved((s) => [...s, d]);
    setMessage(`Zapisano talię "${d.name}".`);
    trackEvent("deck_build_save", { faction, size: cardIds.length });
  }

  function handleDelete(id: string) {
    deleteDeck(id);
    setSaved((s) => s.filter((d) => d.id !== id));
  }

  function resetDeck() {
    setCounts({});
  }

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-4 py-8">
      <Link href="/" className="text-sm text-[var(--text-dim)] hover:text-white">
        ← Powrót
      </Link>
      <h1 className="mt-3 text-3xl font-extrabold">Kreator talii</h1>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-[var(--text-dim)]">Frakcja:</label>
        <select
          value={faction}
          onChange={(e) => {
            setFaction(e.target.value as Faction);
            resetDeck();
          }}
          className="rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1"
        >
          {FACTIONS.map((f) => (
            <option key={f} value={f}>
              {factionTheme(f).label}
            </option>
          ))}
        </select>
        <input
          value={deckName}
          onChange={(e) => setDeckName(e.target.value)}
          className="rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1"
          placeholder="Nazwa talii"
        />
        <button onClick={handleSave} className="rounded bg-white px-3 py-1 font-semibold text-black">
          Zapisz talię
        </button>
        <button onClick={resetDeck} className="rounded border border-[var(--border)] px-3 py-1">
          Wyczyść
        </button>
      </div>

      <div className="mt-3 grid gap-1 text-sm">
        <div>
          Karty: <b className={validation.size === DECK_SIZE ? "text-green-400" : "text-yellow-400"}>{validation.size}/{DECK_SIZE}</b>
          {"  ·  "}Jednostki: {typeCounts.UNIT} · Akcje: {typeCounts.ACTION} · Struktury: {typeCounts.STRUCTURE}
        </div>
        <div className="flex items-end gap-1" aria-label="Krzywa kosztów">
          {curve.map((n, cost) => (
            <div key={cost} className="flex flex-col items-center">
              <div className="flex h-16 w-6 items-end">
                <div className="w-full rounded-t bg-[var(--degens)]" style={{ height: `${Math.min(100, n * 16)}%` }} />
              </div>
              <span className="text-[10px] text-[var(--text-dim)]">{cost === 7 ? "7+" : cost}</span>
              <span className="text-[10px]">{n}</span>
            </div>
          ))}
        </div>
        {!validation.valid && (
          <ul className="mt-1 list-disc pl-5 text-red-400">
            {validation.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
        {validation.valid && <p className="text-green-400">Talia poprawna, gotowa do gry.</p>}
        {message && <p className="text-[var(--text-dim)]">{message}</p>}
      </div>

      <h2 className="mt-6 text-lg font-bold">Dostępne karty ({faction === "MINERS" || faction === "DEGENS" || faction === "BUILDERS" || faction === "VALIDATORS" ? factionTheme(faction).label : faction} + Neutral)</h2>
      <div className="mt-2 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {poolCards.map((c) => {
          const n = counts[c.id] ?? 0;
          const max = c.rarity === "LEGENDARY" ? MAX_COPIES_LEGENDARY : MAX_COPIES_NORMAL;
          return (
            <div key={c.id} className="flex flex-col items-center gap-1">
              <CardView card={c} size="sm" onClick={() => setDetailCard(c.id)} badge={n > 0 ? n : undefined} />
              <div className="flex gap-1">
                <button
                  onClick={() => removeCard(c.id)}
                  disabled={n === 0}
                  className="rounded border border-[var(--border)] px-2 text-xs disabled:opacity-30"
                  aria-label={`Usuń ${c.name}`}
                >
                  −
                </button>
                <button
                  onClick={() => addCard(c.id)}
                  disabled={n >= max || validation.size >= DECK_SIZE}
                  className="rounded border border-[var(--border)] px-2 text-xs disabled:opacity-30"
                  aria-label={`Dodaj ${c.name}`}
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {detailCard && <CardDetailPopover card={CARDS_BY_ID[detailCard]} onClose={() => setDetailCard(null)} />}

      <h2 className="mt-8 text-lg font-bold">Zapisane talie</h2>
      {saved.length === 0 && <p className="text-sm text-[var(--text-dim)]">Brak zapisanych talii.</p>}
      <ul className="mt-2 space-y-2">
        {saved.map((d) => (
          <li key={d.id} className="flex items-center justify-between rounded border border-[var(--border)] p-2 text-sm">
            <span>
              <b>{d.name}</b> — {factionTheme(d.faction).label} ({d.cardIds.length} kart)
            </span>
            <span className="flex gap-2">
              <Link href={`/play?savedDeck=${d.id}`} className="rounded bg-white px-2 py-1 text-xs font-semibold text-black">
                Zagraj tą talią
              </Link>
              <button onClick={() => handleDelete(d.id)} className="rounded border border-red-400 px-2 py-1 text-xs text-red-400">
                Usuń
              </button>
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
