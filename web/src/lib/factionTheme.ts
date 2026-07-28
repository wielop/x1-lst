import type { Faction } from "@/game/types";

export interface FactionTheme {
  color: string;
  bg: string;
  symbol: string; // simple abstract glyph, no borrowed IP
  label: string;
}

export const FACTION_THEME: Record<Faction, FactionTheme> = {
  MINERS: { color: "#d9a441", bg: "#241d10", symbol: "◆", label: "Miners" },
  DEGENS: { color: "#e0524f", bg: "#26130f", symbol: "▲", label: "Degens" },
  BUILDERS: { color: "#4fa8e0", bg: "#0f1c26", symbol: "■", label: "Builders" },
  VALIDATORS: { color: "#4fd18a", bg: "#0f2318", symbol: "⬡", label: "Validators" },
  NEUTRAL: { color: "#9aa3b5", bg: "#1a1d24", symbol: "●", label: "Neutral" },
};

export function factionTheme(f: Faction): FactionTheme {
  return FACTION_THEME[f];
}
