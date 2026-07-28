import { getCard } from "./cards";
import { MAX_UNITS_PER_NODE_PER_PLAYER } from "./constants";
import { enemyCombatTargets, ownUnits } from "./effects";
import type { LegalAttack, LegalPlay, MatchState, NodeIndex, PlayerId, Unit } from "./types";

export function congestionFee(state: MatchState, pid: PlayerId, node: NodeIndex): number {
  return ownUnits(state, node, pid).length;
}

export function costOf(state: MatchState, pid: PlayerId, cardId: string, node: NodeIndex): number {
  const card = getCard(cardId);
  if (card.type === "UNIT") return card.cost + congestionFee(state, pid, node);
  return card.cost;
}

/** All legal (cardId, node) plays available to `pid` right now, one entry per unique card id
 * in hand (mirrors sim/engine.py::legal_plays — duplicates are handled by the caller looping). */
export function legalPlays(state: MatchState, pid: PlayerId): LegalPlay[] {
  const player = state.players[pid];
  const moves: LegalPlay[] = [];
  const seen = new Set<string>();
  for (const cardId of player.hand) {
    if (seen.has(cardId)) continue;
    seen.add(cardId);
    const card = getCard(cardId);
    if (card.type === "UNIT") {
      for (let node = 0 as NodeIndex; node < 3; node++) {
        if (ownUnits(state, node, pid).length >= MAX_UNITS_PER_NODE_PER_PLAYER) continue;
        const cost = costOf(state, pid, cardId, node);
        if (cost <= player.gas) moves.push({ cardId, node, cost });
      }
    } else {
      const cost = card.cost;
      if (cost <= player.gas) {
        for (let node = 0 as NodeIndex; node < 3; node++) {
          moves.push({ cardId, node, cost });
        }
      }
    }
  }
  return moves;
}

/** Human-readable reason a specific (cardId, node) play is illegal right now, or null if legal. */
export function whyIllegalPlay(state: MatchState, pid: PlayerId, cardId: string, node: NodeIndex): string | null {
  const player = state.players[pid];
  if (!player.hand.includes(cardId)) return "Ta karta nie jest w Twojej ręce.";
  const card = getCard(cardId);
  if (card.type === "UNIT" && ownUnits(state, node, pid).length >= MAX_UNITS_PER_NODE_PER_PLAYER) {
    return "Węzeł jest pełny (maks. 4 jednostki na gracza).";
  }
  const cost = costOf(state, pid, cardId, node);
  if (cost > player.gas) {
    return `Za mało energii (koszt ${cost}, masz ${player.gas}).`;
  }
  return null;
}

export function canAttack(unit: Unit, roundNo: number): boolean {
  if (!unit.alive || unit.hp <= 0 || unit.isStructure) return false;
  if (unit.attackedThisRound || unit.overload > 0 || unit.frozen) return false;
  if (unit.enteredRound === roundNo && !unit.keywords.has("RUSH")) return false;
  return true;
}

/** Legal attack targets for a specific attacker: if any enemy Guard unit/structure is present
 * at the node, attacks must be forced onto Guard targets only. */
export function legalAttackTargets(state: MatchState, pid: PlayerId, attacker: Unit): Unit[] {
  if (!canAttack(attacker, state.roundNo)) return [];
  const targets = enemyCombatTargets(state, attacker.node, pid);
  const guards = targets.filter((t) => t.keywords.has("GUARD"));
  return guards.length > 0 ? guards : targets;
}

export function legalAttacks(state: MatchState, pid: PlayerId): LegalAttack[] {
  const out: LegalAttack[] = [];
  for (let node = 0 as NodeIndex; node < 3; node++) {
    for (const unit of state.nodes[node].units[pid]) {
      for (const target of legalAttackTargets(state, pid, unit)) {
        out.push({ attackerIid: unit.iid, targetIid: target.iid });
      }
    }
  }
  return out;
}

export function whyIllegalAttack(
  state: MatchState,
  pid: PlayerId,
  attackerIid: string,
  targetIid: string
): string | null {
  const attacker = state.nodes.flatMap((n) => n.units[pid]).find((u) => u.iid === attackerIid);
  if (!attacker) return "Nieznana jednostka atakująca.";
  if (!canAttack(attacker, state.roundNo)) {
    if (attacker.enteredRound === state.roundNo && !attacker.keywords.has("RUSH")) {
      return "Ta jednostka weszła do gry w tej rundzie i nie ma Rush — nie może jeszcze atakować.";
    }
    if (attacker.attackedThisRound) return "Ta jednostka już atakowała w tej rundzie.";
    if (attacker.frozen) return "Ta jednostka jest zamrożona.";
    if (attacker.overload > 0) return "Ta jednostka jest przeciążona.";
    return "Ta jednostka nie może teraz atakować.";
  }
  const legal = legalAttackTargets(state, pid, attacker);
  if (!legal.some((t) => t.iid === targetIid)) {
    if (legal.length > 0 && legal[0].keywords.has("GUARD")) {
      return "Na tym węźle jest wroga jednostka z Guard — musisz zaatakować ją najpierw.";
    }
    return "Nieprawidłowy cel (nie ma go na tym samym węźle albo nie jest wrogi).";
  }
  return null;
}
