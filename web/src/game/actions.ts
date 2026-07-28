// Action creators — thin, typed helpers around the Action union defined in types.ts.
// Keeping these separate from engine.ts matches the requested module layout and gives the
// UI layer a single import for "how do I build an action" without reaching into types.ts.
import type { Action, NodeIndex, PlayerId } from "./types";

export const Actions = {
  mulligan(player: PlayerId, cardIds: string[]): Action {
    return { type: "MULLIGAN", player, cardIds };
  },
  playCard(player: PlayerId, cardId: string, node: NodeIndex): Action {
    return { type: "PLAY_CARD", player, cardId, node };
  },
  passOrders(player: PlayerId): Action {
    return { type: "PASS_ORDERS", player };
  },
  attack(player: PlayerId, attackerIid: string, targetIid: string): Action {
    return { type: "ATTACK", player, attackerIid, targetIid };
  },
  passCombat(player: PlayerId): Action {
    return { type: "PASS_COMBAT", player };
  },
  concede(player: PlayerId): Action {
    return { type: "CONCEDE", player };
  },
};
