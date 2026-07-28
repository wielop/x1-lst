import { describe, expect, it } from "vitest";
import { CARDS, CARDS_BY_ID, STARTER_DECK_IDS } from "../cards";
import { FACTIONS } from "../decks";

const VALID_TYPES = new Set(["UNIT", "ACTION", "STRUCTURE"]);
const VALID_FACTIONS = new Set(["MINERS", "DEGENS", "BUILDERS", "VALIDATORS", "NEUTRAL"]);
const VALID_RARITIES = new Set(["BASIC", "COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"]);
const KNOWN_EFFECT_OPS = new Set([
  "GAIN_GAS",
  "DRAW",
  "DRAW_AND_GAS",
  "BURN",
  "BURN_WITH_GAS_ON_KILL",
  "POISON",
  "OVERLOAD",
  "FREEZE",
  "DAMAGE_ALL_ENEMIES_AT_NODE",
  "BUFF_ATK",
  "SHIELD_AND_BUFF_HP",
  "GRANT_SHIELD",
  "GRANT_SHIELD_ALL_OWN_AT_NODE",
  "DESTROY_IF",
  "DESTROY_AND_SHIELD",
  "SHIELD_IF_SYNERGY",
  "BURN_SYNERGY",
  "DRAW_SYNERGY",
  "SACRIFICE_OWN_DRAW_GAS",
  "BOUNCE_OWN_DRAW_GAS",
  "RETURN_RANDOM_FROM_GRAVEYARD",
  "BUFF_ATK_HP_ALL_OWN_FACTION_AT_NODE",
]);
const KNOWN_PASSIVE_OPS = new Set([
  "GAIN_GAS_PASSIVE_STRUCTURE",
  "YIELD_AURA",
  "AURA_ATK_FACTION",
  "SYNERGY_ATK_SELF",
  "NO_RETALIATION_DAMAGE_OWN_AT_NODE",
]);
const KNOWN_KEYWORDS = new Set([
  "RUSH",
  "GUARD",
  "RANGED",
  "PUMP",
  "FORTIFY",
  "SYNERGY",
]);

describe("card data integrity", () => {
  it("has exactly 60 cards", () => {
    expect(CARDS.length).toBe(60);
  });

  it("has no duplicate ids", () => {
    const ids = CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has exactly 12 cards per faction + 12 neutral", () => {
    for (const fac of [...FACTIONS, "NEUTRAL"]) {
      expect(CARDS.filter((c) => c.faction === fac).length).toBe(12);
    }
  });

  it.each(CARDS)("card $id ($name) has valid shape", (card) => {
    expect(card.id).toMatch(/^[A-Z]+-\d+$/);
    expect(card.name.length).toBeGreaterThan(0);
    expect(VALID_TYPES.has(card.type)).toBe(true);
    expect(VALID_FACTIONS.has(card.faction)).toBe(true);
    expect(VALID_RARITIES.has(card.rarity)).toBe(true);
    expect(card.cost).toBeGreaterThanOrEqual(1);
    expect(card.copies).toBeGreaterThanOrEqual(1);
    expect(card.copies).toBeLessThanOrEqual(2);
    if (card.rarity === "LEGENDARY") expect(card.copies).toBe(1);

    if (card.type === "UNIT" || card.type === "STRUCTURE") {
      expect(card.hp).not.toBeNull();
      expect(card.hp as number).toBeGreaterThan(0);
    }
    if (card.type === "UNIT") {
      expect(card.atk).not.toBeNull();
      expect(card.atk as number).toBeGreaterThanOrEqual(0);
    }
    if (card.type === "ACTION") {
      expect(card.atk).toBeNull();
      expect(card.hp).toBeNull();
    }

    for (const kw of card.keywords) {
      const base = kw.startsWith("YIELD_") ? "YIELD_" : kw;
      if (base !== "YIELD_") expect(KNOWN_KEYWORDS.has(kw)).toBe(true);
    }

    if (card.onPlay) expect(KNOWN_EFFECT_OPS.has(card.onPlay.op)).toBe(true);
    if (card.onDeath) expect(KNOWN_EFFECT_OPS.has(card.onDeath.op)).toBe(true);
    if (card.passive) {
      const isYield = card.passive.op === undefined; // defensive
      expect(KNOWN_PASSIVE_OPS.has(card.passive.op) || isYield).toBe(true);
    }

    expect(card.text.length).toBeGreaterThan(0);
  });

  it("CARDS_BY_ID lookup matches CARDS array", () => {
    for (const c of CARDS) {
      expect(CARDS_BY_ID[c.id]).toBe(c);
    }
  });

  it("every starter deck has exactly 20 cards referencing real card ids", () => {
    for (const [faction, ids] of Object.entries(STARTER_DECK_IDS)) {
      expect(ids.length).toBe(20);
      for (const id of ids) {
        expect(CARDS_BY_ID[id]).toBeDefined();
        expect(CARDS_BY_ID[id].faction === faction || CARDS_BY_ID[id].faction === "NEUTRAL").toBe(true);
      }
    }
  });

  it("no starter deck exceeds max copies (2 normal / 1 legendary)", () => {
    for (const ids of Object.values(STARTER_DECK_IDS)) {
      const counts = new Map<string, number>();
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const [id, count] of counts) {
        const max = CARDS_BY_ID[id].rarity === "LEGENDARY" ? 1 : 2;
        expect(count).toBeLessThanOrEqual(max);
      }
    }
  });
});
