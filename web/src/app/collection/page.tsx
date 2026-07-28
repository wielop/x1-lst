"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { CARDS, STARTER_DECK_IDS } from "@/game/cards";
import type { Card, Faction, Rarity } from "@/game/types";
import { CardWithDetail } from "@/components/CardView";
import { factionTheme } from "@/lib/factionTheme";

const FACTIONS: (Faction | "ALL")[] = ["ALL", "MINERS", "DEGENS", "BUILDERS", "VALIDATORS", "NEUTRAL"];
const TYPES: (Card["type"] | "ALL")[] = ["ALL", "UNIT", "ACTION", "STRUCTURE"];
const RARITIES: (Rarity | "ALL")[] = ["ALL", "BASIC", "COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"];
const ALL_KEYWORDS = [...new Set(CARDS.flatMap((c) => c.keywords))].sort();

function decksContaining(cardId: string): string[] {
  return Object.entries(STARTER_DECK_IDS)
    .filter(([, ids]) => ids.includes(cardId))
    .map(([faction]) => faction);
}

export default function CollectionPage() {
  const [faction, setFaction] = useState<Faction | "ALL">("ALL");
  const [type, setType] = useState<Card["type"] | "ALL">("ALL");
  const [rarity, setRarity] = useState<Rarity | "ALL">("ALL");
  const [keyword, setKeyword] = useState<string>("ALL");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    return CARDS.filter((c) => {
      if (faction !== "ALL" && c.faction !== faction) return false;
      if (type !== "ALL" && c.type !== type) return false;
      if (rarity !== "ALL" && c.rarity !== rarity) return false;
      if (keyword !== "ALL" && !c.keywords.includes(keyword)) return false;
      if (query && !c.name.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [faction, type, rarity, keyword, query]);

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-4 py-8">
      <Link href="/" className="text-sm text-[var(--text-dim)] hover:text-white">
        ← Powrót
      </Link>
      <h1 className="mt-3 text-3xl font-extrabold">Kolekcja ({CARDS.length} kart)</h1>
      <p className="text-sm text-[var(--text-dim)]">Wszystkie karty są bezpłatne i dostępne od razu — brak paczek na tym etapie.</p>

      <div className="mt-5 flex flex-wrap gap-3 text-sm">
        <select value={faction} onChange={(e) => setFaction(e.target.value as Faction | "ALL")} className="rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1">
          {FACTIONS.map((f) => (
            <option key={f} value={f}>
              {f === "ALL" ? "Wszystkie frakcje" : factionTheme(f).label}
            </option>
          ))}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value as Card["type"] | "ALL")} className="rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1">
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t === "ALL" ? "Wszystkie typy" : t}
            </option>
          ))}
        </select>
        <select value={rarity} onChange={(e) => setRarity(e.target.value as Rarity | "ALL")} className="rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1">
          {RARITIES.map((r) => (
            <option key={r} value={r}>
              {r === "ALL" ? "Wszystkie rzadkości" : r}
            </option>
          ))}
        </select>
        <select value={keyword} onChange={(e) => setKeyword(e.target.value)} className="rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1">
          <option value="ALL">Wszystkie słowa kluczowe</option>
          {ALL_KEYWORDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Szukaj po nazwie…"
          className="min-w-40 flex-1 rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1"
        />
      </div>

      <p className="mt-3 text-xs text-[var(--text-dim)]">{filtered.length} kart pasuje do filtrów</p>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {filtered.map((c) => {
          const decks = decksContaining(c.id);
          return (
            <div key={c.id} className="flex flex-col items-center gap-1">
              <CardWithDetail card={c} />
              {decks.length > 0 && (
                <span className="text-[10px] text-[var(--text-dim)]">W talii: {decks.join(", ")}</span>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
