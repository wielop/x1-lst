// Core type definitions for the Node Clash engine.
// Mirrors the data model documented in docs/04-engine-model.md and the reference
// Python implementation in sim/engine.py + sim/cards_data.py.

export type Faction = "MINERS" | "DEGENS" | "BUILDERS" | "VALIDATORS" | "NEUTRAL";
export type CardType = "UNIT" | "ACTION" | "STRUCTURE";
export type Rarity = "BASIC" | "COMMON" | "UNCOMMON" | "RARE" | "EPIC" | "LEGENDARY";
export type NodeIndex = 0 | 1 | 2;
export type PlayerId = 0 | 1;
export type Keyword = "RUSH" | "GUARD" | "RANGED" | "PUMP" | "FORTIFY" | "SYNERGY" | string;

// ---- Effects ----
// A generic {op, ...params} shape, matching the Python EffectSpec dicts 1:1 so the
// card JSON can be shared/ported without reinterpretation.
export interface EffectSpec {
  op: string;
  amount?: number;
  draw?: number;
  gas?: number;
  gas_on_kill?: number;
  target?: string;
  shield_target?: string;
  hp?: number;
  atk?: number;
  condition?: string;
  value?: number;
  min_synergy?: number;
  base?: number;
  per?: number;
  max_draw?: number;
}

export interface PassiveSpec {
  op: string;
  amount?: number;
  faction?: Faction;
}

export interface Card {
  id: string;
  name: string;
  type: CardType;
  faction: Faction;
  cost: number;
  atk: number | null;
  hp: number | null;
  rarity: Rarity;
  keywords: string[];
  onPlay: EffectSpec | null;
  passive: PassiveSpec | null;
  onDeath: EffectSpec | null;
  text: string;
  copies: number;
}

// ---- Runtime state ----
export interface Unit {
  iid: string;
  cardId: string;
  owner: PlayerId;
  node: NodeIndex;
  hp: number;
  atk: number; // base + permanent modifiers (node-enter bonus, PUMP, BUFF_ATK) — dynamic
  // aura bonuses are computed on demand via effectiveAtk(), never stored here.
  isStructure: boolean;
  keywords: Set<string>;
  shield: boolean;
  poison: number;
  overload: number;
  frozen: boolean;
  enteredRound: number;
  attackedThisRound: boolean;
  attackedPrevRound: boolean;
  pumpUsed: boolean;
  alive: boolean;
}

export interface NodeState {
  index: NodeIndex;
  passive: (typeof import("./constants").NODE_PASSIVES)[number];
  units: Record<PlayerId, Unit[]>;
  structures: Record<PlayerId, Unit[]>;
}

export interface PlayerState {
  id: PlayerId;
  deck: string[];
  hand: string[];
  graveyard: string[];
  gas: number;
  faction: Faction;
}

export type Phase =
  | "MULLIGAN"
  | "ORDERS_ACTIVE"
  | "ORDERS_INACTIVE"
  | "COMBAT_ACTIVE"
  | "COMBAT_INACTIVE"
  | "GAME_OVER";

export interface MatchResult {
  winner: PlayerId | null;
  reason: "control_2_nodes" | "total_hashpower_tiebreak" | "draw" | "concede";
  hashpower: Record<PlayerId, [number, number, number]>;
  nodesControl: [PlayerId | null, PlayerId | null, PlayerId | null];
  total: [number, number];
  roundsPlayed: number;
}

export interface GameEvent {
  round: number;
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface MatchState {
  seed: number;
  rngState: number; // mulberry32 internal state, advanced deterministically
  unitCounter: number; // monotonic counter for deterministic unit instance ids (no Math.random)
  roundNo: number;
  phase: Phase;
  activePlayer: PlayerId; // player with initiative this round
  nodes: [NodeState, NodeState, NodeState];
  players: Record<PlayerId, PlayerState>;
  result: MatchResult | null;
  events: GameEvent[];
  playRecords: { round: number; player: PlayerId; cardId: string }[];
  mulliganDone: Record<PlayerId, boolean>;
  cardDataVersion: string;
  engineVersion: string;
}

// ---- Actions (the public API surface of the engine) ----
export type Action =
  | { type: "MULLIGAN"; player: PlayerId; cardIds: string[] }
  | { type: "PLAY_CARD"; player: PlayerId; cardId: string; node: NodeIndex }
  | { type: "PASS_ORDERS"; player: PlayerId }
  | { type: "ATTACK"; player: PlayerId; attackerIid: string; targetIid: string }
  | { type: "PASS_COMBAT"; player: PlayerId }
  | { type: "CONCEDE"; player: PlayerId };

export interface ActionResult {
  state: MatchState;
  events: GameEvent[];
  error: string | null;
}

export interface LegalPlay {
  cardId: string;
  node: NodeIndex;
  cost: number;
}

export interface LegalAttack {
  attackerIid: string;
  targetIid: string;
}
