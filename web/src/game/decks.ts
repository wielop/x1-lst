import { CARDS_BY_ID, STARTER_DECK_IDS } from "./cards";
import { DECK_SIZE, MAX_COPIES_LEGENDARY, MAX_COPIES_NORMAL, MIN_UNIT_CARDS_IN_DECK } from "./constants";
import type { Faction } from "./types";

export type PlayableFaction = Exclude<Faction, "NEUTRAL">;

export const FACTIONS: PlayableFaction[] = ["MINERS", "DEGENS", "BUILDERS", "VALIDATORS"];

export interface StarterDeckMeta {
  faction: Faction;
  name: string;
  archetype: string;
  difficulty: "Prosta" | "Agresywna" | "Kontrolna" | "Comboowa";
  strengths: string[];
  weaknesses: string[];
  keyCardIds: [string, string, string];
}

export const STARTER_DECK_META: Record<Exclude<Faction, "NEUTRAL">, StarterDeckMeta> = {
  MINERS: {
    faction: "MINERS",
    name: "Rig Starter",
    archetype: "Ekonomia / Yield",
    difficulty: "Prosta",
    strengths: ["Rosnąca przewaga Gas w późnych rundach", "Odporność na wymiany 1:1"],
    weaknesses: ["Wolny start (runda 1-2)", "Słaba bezpośrednia usuwalność zagrożeń"],
    keyCardIds: ["MIN-07", "MIN-11", "MIN-12"],
  },
  DEGENS: {
    faction: "DEGENS",
    name: "Ape Starter",
    archetype: "Agresja / Pump",
    difficulty: "Agresywna",
    strengths: ["Bardzo wysoki wczesny Hashpower", "Presja zanim przeciwnik się rozwinie"],
    weaknesses: ["Krucha linia jednostek", "Słabo radzi sobie z wysokim HP / Guard"],
    keyCardIds: ["DEG-06", "DEG-07", "DEG-12"],
  },
  BUILDERS: {
    faction: "BUILDERS",
    name: "Protocol Starter",
    archetype: "Synergia / Kombinacje",
    difficulty: "Comboowa",
    strengths: ["Duży, składany payoff przy 3+ jednostkach na węźle", "Trudny do przewidzenia moment wybuchu"],
    weaknesses: ["Wymaga 2-3 rund rozbiegu", "Opłata przeciążeniowa karze stackowanie"],
    keyCardIds: ["BLD-03", "BLD-09", "BLD-12"],
  },
  VALIDATORS: {
    faction: "VALIDATORS",
    name: "Sentinel Starter",
    archetype: "Kontrola / Obrona",
    difficulty: "Kontrolna",
    strengths: ["Świetna defensywa (Guard/Fortify)", "Dobre usuwanie tanich zagrożeń"],
    weaknesses: ["Niski proaktywny Hashpower wcześnie", "3 węzły do obrony, ograniczona liczba jednostek"],
    keyCardIds: ["VAL-06", "VAL-11", "VAL-12"],
  },
};

export function starterDeck(faction: Faction): string[] {
  const ids = STARTER_DECK_IDS[faction];
  if (!ids) throw new Error(`No starter deck for faction ${faction}`);
  return [...ids];
}

export interface DeckValidationResult {
  valid: boolean;
  errors: string[];
  size: number;
  faction: Faction | null;
  unitCount: number;
  actionCount: number;
  structureCount: number;
}

/** Validates a deck (list of card ids, duplicates repeated) against Node Clash deckbuilding
 * rules (docs/02-rules.md §4.8): exactly 20 cards, max 2 copies (1 for Legendary), single
 * faction + neutral, min 10 unit cards. */
export function validateDeck(cardIds: string[]): DeckValidationResult {
  const errors: string[] = [];
  const counts = new Map<string, number>();
  let faction: Faction | null = null;
  let unitCount = 0;
  let actionCount = 0;
  let structureCount = 0;

  for (const id of cardIds) {
    const card = CARDS_BY_ID[id];
    if (!card) {
      errors.push(`Nieznana karta: ${id}`);
      continue;
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (card.faction !== "NEUTRAL") {
      if (faction === null) faction = card.faction;
      else if (faction !== card.faction) {
        errors.push(`Talia zawiera więcej niż jedną frakcję: ${faction} i ${card.faction}`);
      }
    }
    if (card.type === "UNIT") unitCount++;
    else if (card.type === "ACTION") actionCount++;
    else structureCount++;
  }

  for (const [id, count] of counts) {
    const card = CARDS_BY_ID[id];
    if (!card) continue;
    const max = card.rarity === "LEGENDARY" ? MAX_COPIES_LEGENDARY : MAX_COPIES_NORMAL;
    if (count > max) {
      errors.push(`Za dużo kopii "${card.name}" (${count}/${max})`);
    }
  }

  if (cardIds.length !== DECK_SIZE) {
    errors.push(`Talia ma ${cardIds.length} kart, wymagane dokładnie ${DECK_SIZE}`);
  }
  if (unitCount < MIN_UNIT_CARDS_IN_DECK) {
    errors.push(`Za mało jednostek (${unitCount}/${MIN_UNIT_CARDS_IN_DECK} minimum)`);
  }

  return {
    valid: errors.length === 0,
    errors,
    size: cardIds.length,
    faction,
    unitCount,
    actionCount,
    structureCount,
  };
}
