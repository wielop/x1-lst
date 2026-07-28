// Node Clash engine constants.
// Values here are the FINAL, post-balance (v3) numbers from the reference Python
// simulator (/home/wielop/x1-card-arena/sim/results/FINAL_BALANCED_CARDS_v3.json
// engine_constants block). Do not change without re-running the balance simulation.

export const ROUNDS = 6;
export const MAX_UNITS_PER_NODE_PER_PLAYER = 4;
export const GAS_HARD_CAP = 7;

/** Player 2 no longer gets a 5th opening card (that was the v0/v1 baseline and proved to
 * overvalue P2 — see docs/13/14). Instead P2 gets a small, one-time Gas bonus in round 1. */
export const P2_EXTRA_CARD = false;
export const P2_EXTRA_GAS_R1 = 1;

export const NODE_PASSIVES = ["FAST_LANE", "COLD_STORAGE", "PUBLIC_MEMPOOL"] as const;

export const DECK_SIZE = 20;
export const MULLIGAN_HAND_P0 = 4;
export const MULLIGAN_HAND_P1 = 4;

export const MAX_COPIES_NORMAL = 2;
export const MAX_COPIES_LEGENDARY = 1;
export const MIN_UNIT_CARDS_IN_DECK = 10;

export const CARD_DATA_VERSION = "v3_tuned";
export const ENGINE_VERSION = "1.0.0";
