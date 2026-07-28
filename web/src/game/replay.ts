// Replay recording/export/import. A replay is the minimal data needed to deterministically
// reconstruct a match: the seed, both decks/factions, and the ordered list of actions taken.
// Replaying means feeding those actions back through initMatch + applyAction — this does
// NOT require re-running the bot's decision logic, so it stays deterministic regardless of
// how the original actions were chosen (see bot.ts comment on RNG usage).
import { initMatch, applyAction, getActingPlayer } from "./engine";
import { CARD_DATA_VERSION, ENGINE_VERSION } from "./constants";
import type { Action, Faction, MatchResult, MatchState } from "./types";

export interface Replay {
  formatVersion: 1;
  seed: number;
  deckA: string[];
  deckB: string[];
  factionA: Faction;
  factionB: Faction;
  botDifficulty: string | null;
  actions: Action[];
  result: MatchResult | null;
  cardDataVersion: string;
  engineVersion: string;
  createdAt: string;
}

export function createReplayRecorder(
  seed: number,
  deckA: string[],
  deckB: string[],
  factionA: Faction,
  factionB: Faction,
  botDifficulty: string | null
): Replay {
  return {
    formatVersion: 1,
    seed,
    deckA,
    deckB,
    factionA,
    factionB,
    botDifficulty,
    actions: [],
    result: null,
    cardDataVersion: CARD_DATA_VERSION,
    engineVersion: ENGINE_VERSION,
    createdAt: new Date().toISOString(),
  };
}

export function recordAction(replay: Replay, action: Action): Replay {
  return { ...replay, actions: [...replay.actions, action] };
}

export function finalizeReplay(replay: Replay, result: MatchResult): Replay {
  return { ...replay, result };
}

export function exportReplayJson(replay: Replay): string {
  return JSON.stringify(replay, null, 2);
}

export function parseReplayJson(json: string): Replay {
  const data = JSON.parse(json) as Partial<Replay>;
  if (data.formatVersion !== 1) throw new Error("Nieobsługiwana wersja formatu replaya.");
  if (!Array.isArray(data.actions) || !data.deckA || !data.deckB) {
    throw new Error("Uszkodzony plik replaya.");
  }
  return data as Replay;
}

export interface ReplayStep {
  state: MatchState;
  actionApplied: Action | null;
}

/** Reconstructs the full sequence of states by replaying a recorded match from scratch. */
export function replayMatch(replay: Replay): ReplayStep[] {
  let state = initMatch(replay.deckA, replay.deckB, replay.factionA, replay.factionB, replay.seed);
  const steps: ReplayStep[] = [{ state, actionApplied: null }];
  for (const action of replay.actions) {
    const result = applyAction(state, action);
    if (result.error) {
      throw new Error(`Replay się rozjechał na akcji ${JSON.stringify(action)}: ${result.error}`);
    }
    state = result.state;
    steps.push({ state, actionApplied: action });
  }
  return steps;
}

export function isMatchOver(state: MatchState): boolean {
  return getActingPlayer(state) === null;
}
