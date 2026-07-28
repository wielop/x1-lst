"use client";
// localStorage-backed persistence for saved decks and telemetry. Versioned so a future card
// data update can never crash the app on load — invalid/stale saved decks are dropped (and
// flagged to the caller) instead of throwing.
import { validateDeck } from "@/game/decks";
import { CARD_DATA_VERSION } from "@/game/constants";
import type { Faction } from "@/game/types";

const DECKS_KEY = "nodeclash:decks:v1";
const TELEMETRY_KEY = "nodeclash:telemetry:v1";
const SETTINGS_KEY = "nodeclash:settings:v1";

export interface SavedDeck {
  id: string;
  name: string;
  faction: Faction;
  cardIds: string[];
  cardDataVersion: string;
  createdAt: string;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function loadSavedDecks(): { decks: SavedDeck[]; droppedCount: number } {
  if (typeof window === "undefined") return { decks: [], droppedCount: 0 };
  const raw = safeParse<SavedDeck[]>(window.localStorage.getItem(DECKS_KEY), []);
  const valid: SavedDeck[] = [];
  let dropped = 0;
  for (const d of raw) {
    if (!d || !Array.isArray(d.cardIds) || typeof d.faction !== "string") {
      dropped++;
      continue;
    }
    const check = validateDeck(d.cardIds);
    if (!check.valid) {
      dropped++;
      continue;
    }
    valid.push(d);
  }
  return { decks: valid, droppedCount: dropped };
}

export function saveDeck(deck: Omit<SavedDeck, "id" | "createdAt" | "cardDataVersion">): SavedDeck {
  const { decks } = loadSavedDecks();
  const newDeck: SavedDeck = {
    ...deck,
    id: `deck-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    cardDataVersion: CARD_DATA_VERSION,
    createdAt: new Date().toISOString(),
  };
  const next = [...decks, newDeck];
  window.localStorage.setItem(DECKS_KEY, JSON.stringify(next));
  return newDeck;
}

export function deleteDeck(id: string): void {
  const { decks } = loadSavedDecks();
  window.localStorage.setItem(DECKS_KEY, JSON.stringify(decks.filter((d) => d.id !== id)));
}

// ---- Telemetry ----
export interface TelemetryEvent {
  type: string;
  ts: string;
  data?: Record<string, unknown>;
}

const MAX_TELEMETRY_EVENTS = 500;

export function trackEvent(type: string, data?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const events = safeParse<TelemetryEvent[]>(window.localStorage.getItem(TELEMETRY_KEY), []);
  events.push({ type, ts: new Date().toISOString(), data });
  const trimmed = events.slice(-MAX_TELEMETRY_EVENTS);
  window.localStorage.setItem(TELEMETRY_KEY, JSON.stringify(trimmed));
}

export function getTelemetry(): TelemetryEvent[] {
  if (typeof window === "undefined") return [];
  return safeParse<TelemetryEvent[]>(window.localStorage.getItem(TELEMETRY_KEY), []);
}

export function exportTelemetryJson(): string {
  return JSON.stringify(getTelemetry(), null, 2);
}

export function clearTelemetry(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TELEMETRY_KEY);
}

// ---- Small settings (e.g. "has completed tutorial") ----
interface Settings {
  tutorialCompleted?: boolean;
}

export function getSettings(): Settings {
  if (typeof window === "undefined") return {};
  return safeParse<Settings>(window.localStorage.getItem(SETTINGS_KEY), {});
}

export function updateSettings(patch: Partial<Settings>): void {
  if (typeof window === "undefined") return;
  const next = { ...getSettings(), ...patch };
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
}
