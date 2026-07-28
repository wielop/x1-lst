// Deterministic seeded RNG (mulberry32) + deck/hand primitives shared by engine.ts and
// effects.ts. Not bit-compatible with Python's Mersenne Twister — the TS engine defines
// its own self-consistent deterministic RNG (same seed -> same TS result, always), which is
// what "deterministic" means for this engine. Cross-language parity is verified at the rules
// level (fixed board states -> fixed outcomes), not at the RNG-stream level — see
// src/game/__tests__/parity.test.ts.
import type { MatchState, PlayerId } from "./types";

export function nextRandom(state: MatchState): number {
  let t = (state.rngState += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const result = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return result;
}

export function rngInt(state: MatchState, maxExclusive: number): number {
  return Math.floor(nextRandom(state) * maxExclusive);
}

export function rngChoice<T>(state: MatchState, arr: T[]): T {
  return arr[rngInt(state, arr.length)];
}

/** Fisher-Yates shuffle, in place, using the match's seeded RNG stream. */
export function shuffleDeck(state: MatchState, pid: PlayerId): void {
  const deck = state.players[pid].deck;
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rngInt(state, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

export function drawCards(state: MatchState, pid: PlayerId, n: number): string[] {
  const player = state.players[pid];
  const drawn: string[] = [];
  for (let i = 0; i < n; i++) {
    const card = player.deck.shift();
    if (card === undefined) break;
    drawn.push(card);
  }
  player.hand.push(...drawn);
  return drawn;
}
