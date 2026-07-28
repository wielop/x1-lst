// One-time generator: reads the authoritative, fully-balanced (v3) card data produced by
// the Python reference simulator and emits src/game/cards.ts as a typed TS module.
// Source of truth: /home/wielop/x1-card-arena/sim/results/FINAL_BALANCED_CARDS_v3.json
// Run with: npx tsx scripts/generate-cards.ts
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const SOURCE = "/home/wielop/x1-card-arena/sim/results/FINAL_BALANCED_CARDS_v3.json";

interface PyEffect {
  op: string;
  [k: string]: unknown;
}
interface PyCard {
  id: string;
  name: string;
  type: string;
  faction: string;
  cost: number;
  atk: number | null;
  hp: number | null;
  rarity: string;
  keywords: string[];
  on_play: PyEffect | null;
  passive: PyEffect | null;
  on_death: PyEffect | null;
  text: string;
  copies: number;
}

const raw = JSON.parse(readFileSync(SOURCE, "utf-8")) as {
  cards: PyCard[];
  starter_decks: Record<string, string[]>;
};

function fixText(text: string): string {
  // Stale flavor text from before GAS_HARD_CAP was patched 8 -> 7 in balance iteration 1.
  return text.replace("limit Gas/rundę: 8", "limit Gas/rundę: 7");
}

const cardsTs = raw.cards
  .map((c) => {
    const onPlay = c.on_play ? JSON.stringify(c.on_play) : "null";
    const passive = c.passive ? JSON.stringify(c.passive) : "null";
    const onDeath = c.on_death ? JSON.stringify(c.on_death) : "null";
    return `  {
    id: ${JSON.stringify(c.id)},
    name: ${JSON.stringify(c.name)},
    type: ${JSON.stringify(c.type)},
    faction: ${JSON.stringify(c.faction)},
    cost: ${c.cost},
    atk: ${c.atk === null ? "null" : c.atk},
    hp: ${c.hp === null ? "null" : c.hp},
    rarity: ${JSON.stringify(c.rarity)},
    keywords: ${JSON.stringify(c.keywords)},
    onPlay: ${onPlay},
    passive: ${passive},
    onDeath: ${onDeath},
    text: ${JSON.stringify(fixText(c.text))},
    copies: ${c.copies},
  },`;
  })
  .join("\n");

const decksTs = Object.entries(raw.starter_decks)
  .map(([faction, ids]) => `  ${faction}: ${JSON.stringify(ids)},`)
  .join("\n");

const out = `// GENERATED FILE — do not edit by hand.
// Produced by scripts/generate-cards.ts from the authoritative, fully-balanced (v3)
// card data exported by the Python reference simulator (sim/results/FINAL_BALANCED_CARDS_v3.json).
// Regenerate with: npx tsx scripts/generate-cards.ts
import type { Card } from "./types";

export const CARDS: Card[] = [
${cardsTs}
] as unknown as Card[];

export const CARDS_BY_ID: Record<string, Card> = Object.fromEntries(
  CARDS.map((c) => [c.id, c])
);

export const STARTER_DECK_IDS: Record<string, string[]> = {
${decksTs}
};

export function getCard(id: string): Card {
  const c = CARDS_BY_ID[id];
  if (!c) throw new Error(\`Unknown card id: \${id}\`);
  return c;
}
`;

writeFileSync(resolve(__dirname, "../src/game/cards.ts"), out, "utf-8");
console.log(`Wrote ${raw.cards.length} cards -> src/game/cards.ts`);
