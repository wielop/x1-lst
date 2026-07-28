import { getCard } from "./cards";
import { GAS_HARD_CAP, MULLIGAN_HAND_P0, MULLIGAN_HAND_P1, NODE_PASSIVES, P2_EXTRA_CARD, P2_EXTRA_GAS_R1, ROUNDS, CARD_DATA_VERSION, ENGINE_VERSION } from "./constants";
import { effectiveAtk, ownUnits, resolveEffect } from "./effects";
import { drawCards, shuffleDeck } from "./engine-rng";
import { costOf, legalAttacks, legalPlays, whyIllegalAttack, whyIllegalPlay } from "./validation";
import type {
  Action,
  ActionResult,
  Faction,
  GameEvent,
  MatchResult,
  MatchState,
  NodeIndex,
  NodeState,
  PlayerId,
  PlayerState,
  Unit,
} from "./types";

function newUnit(state: MatchState, cardId: string, owner: PlayerId, node: NodeIndex, roundNo: number): Unit {
  const c = getCard(cardId);
  state.unitCounter += 1;
  return {
    iid: `u${state.unitCounter}-${cardId}`,
    cardId,
    owner,
    node,
    hp: c.hp ?? 0,
    atk: c.atk ?? 0,
    isStructure: c.type === "STRUCTURE",
    keywords: new Set(c.keywords),
    shield: false,
    poison: 0,
    overload: 0,
    frozen: false,
    enteredRound: roundNo,
    attackedThisRound: false,
    attackedPrevRound: false,
    pumpUsed: false,
    alive: true,
  };
}

export function initMatch(
  deckA: string[],
  deckB: string[],
  factionA: Faction,
  factionB: Faction,
  seed: number
): MatchState {
  function makeNode(i: NodeIndex): NodeState {
    return {
      index: i,
      passive: NODE_PASSIVES[i],
      units: { 0: [], 1: [] },
      structures: { 0: [], 1: [] },
    };
  }
  const nodes: [NodeState, NodeState, NodeState] = [makeNode(0), makeNode(1), makeNode(2)];

  const players: Record<PlayerId, PlayerState> = {
    0: { id: 0, deck: [...deckA], hand: [], graveyard: [], gas: 0, faction: factionA },
    1: { id: 1, deck: [...deckB], hand: [], graveyard: [], gas: 0, faction: factionB },
  };

  const state: MatchState = {
    seed,
    rngState: seed >>> 0 || 1,
    unitCounter: 0,
    roundNo: 0,
    phase: "MULLIGAN",
    activePlayer: 0,
    nodes,
    players,
    result: null,
    events: [],
    playRecords: [],
    mulliganDone: { 0: false, 1: false },
    cardDataVersion: CARD_DATA_VERSION,
    engineVersion: ENGINE_VERSION,
  };

  shuffleDeck(state, 0);
  shuffleDeck(state, 1);
  drawCards(state, 0, MULLIGAN_HAND_P0);
  drawCards(state, 1, P2_EXTRA_CARD ? MULLIGAN_HAND_P1 + 1 : MULLIGAN_HAND_P1);

  return state;
}

function getActingPlayer(state: MatchState): PlayerId | null {
  switch (state.phase) {
    case "MULLIGAN":
      if (!state.mulliganDone[0]) return 0;
      if (!state.mulliganDone[1]) return 1;
      return null;
    case "ORDERS_ACTIVE":
      return state.activePlayer;
    case "ORDERS_INACTIVE":
      return (1 - state.activePlayer) as PlayerId;
    case "COMBAT_ACTIVE":
      return state.activePlayer;
    case "COMBAT_INACTIVE":
      return (1 - state.activePlayer) as PlayerId;
    case "GAME_OVER":
      return null;
  }
}

function pushEvent(events: GameEvent[], state: MatchState, type: string, message: string, data?: Record<string, unknown>) {
  events.push({ round: state.roundNo, type, message, data });
}

function gasPhase(state: MatchState, events: GameEvent[]) {
  const base = Math.min(state.roundNo, 6);
  for (const pid of [0, 1] as PlayerId[]) {
    let yieldBonus = 0;
    for (const node of state.nodes) {
      for (const u of ownUnits(state, node.index, pid)) {
        for (const kw of u.keywords) {
          if (kw.startsWith("YIELD_")) yieldBonus += parseInt(kw.split("_")[1], 10);
        }
        for (const other of ownUnits(state, node.index, pid)) {
          if (other.iid === u.iid) continue;
          const p = getCard(other.cardId).passive;
          if (p && p.op === "YIELD_AURA") yieldBonus += p.amount ?? 0;
        }
      }
      for (const s of node.structures[pid]) {
        if (s.alive && getCard(s.cardId).passive?.op === "GAIN_GAS_PASSIVE_STRUCTURE") {
          yieldBonus += getCard(s.cardId).passive?.amount ?? 0;
        }
      }
    }
    state.players[pid].gas = Math.min(base + yieldBonus, GAS_HARD_CAP);
  }
  if (state.roundNo === 1 && P2_EXTRA_GAS_R1) {
    state.players[1].gas = Math.min(state.players[1].gas + P2_EXTRA_GAS_R1, GAS_HARD_CAP);
  }
  for (const node of state.nodes) {
    for (const pid of [0, 1] as PlayerId[]) {
      for (const u of ownUnits(state, node.index, pid)) {
        if (u.keywords.has("FORTIFY") && !u.attackedPrevRound) u.shield = true;
      }
    }
  }
  pushEvent(events, state, "GAS_PHASE", `Runda ${state.roundNo}: Gas ${state.players[0].gas} / ${state.players[1].gas}`);
}

function drawPhase(state: MatchState, events: GameEvent[]) {
  drawCards(state, 0, 1);
  drawCards(state, 1, 1);
  pushEvent(events, state, "DRAW_PHASE", "Obaj gracze dobierają kartę.");
}

function beginRound(state: MatchState, roundNo: number, events: GameEvent[]) {
  state.roundNo = roundNo;
  state.activePlayer = roundNo % 2 === 1 ? 0 : 1;
  gasPhase(state, events);
  drawPhase(state, events);
  state.phase = "ORDERS_ACTIVE";
}

function applyPlay(state: MatchState, pid: PlayerId, cardId: string, node: NodeIndex, events: GameEvent[]) {
  const player = state.players[pid];
  const card = getCard(cardId);
  const cost = costOf(state, pid, cardId, node);
  player.gas -= cost;
  player.hand.splice(player.hand.indexOf(cardId), 1);
  state.playRecords.push({ round: state.roundNo, player: pid, cardId });

  if (card.type === "UNIT") {
    const unit = newUnit(state, cardId, pid, node, state.roundNo);
    if (state.nodes[node].passive === "FAST_LANE") unit.atk += 1;
    if (state.nodes[node].passive === "COLD_STORAGE") unit.shield = true;
    state.nodes[node].units[pid].push(unit);
    pushEvent(events, state, "PLAY", `${playerLabel(pid)} zagrywa ${card.name} na Węzeł ${node + 1}`, { cardId, node });
    if (card.onPlay) resolveEffect(state, pid, node, card.onPlay, unit, events);
  } else if (card.type === "STRUCTURE") {
    const unit = newUnit(state, cardId, pid, node, state.roundNo);
    state.nodes[node].structures[pid].push(unit);
    pushEvent(events, state, "PLAY", `${playerLabel(pid)} zagrywa strukturę ${card.name} na Węzeł ${node + 1}`, { cardId, node });
  } else {
    player.graveyard.push(cardId);
    pushEvent(events, state, "PLAY", `${playerLabel(pid)} zagrywa akcję ${card.name} na Węźle ${node + 1}`, { cardId, node });
    if (card.onPlay) resolveEffect(state, pid, node, card.onPlay, null, events);
  }
}

function playerLabel(pid: PlayerId): string {
  return pid === 0 ? "Gracz" : "Przeciwnik";
}

function deathCheck(state: MatchState, events: GameEvent[]) {
  const dead: Unit[] = [];
  for (const node of state.nodes) {
    for (const pid of [0, 1] as PlayerId[]) {
      for (const u of node.units[pid]) {
        if (u.alive && u.hp <= 0) dead.push(u);
      }
    }
  }
  dead.sort((a, b) => (a.owner === state.roundNo % 2 ? -1 : 1) - (b.owner === state.roundNo % 2 ? -1 : 1));
  for (const u of dead) {
    u.alive = false;
    const node = state.nodes[u.node];
    node.units[u.owner] = node.units[u.owner].filter((x) => x.iid !== u.iid);
    const card = getCard(u.cardId);
    pushEvent(events, state, "DEATH", `${card.name} ginie na Węźle ${u.node + 1}`, { cardId: u.cardId, node: u.node });
    if (card.onDeath) resolveEffect(state, u.owner, u.node, card.onDeath, null, events);
    if (node.passive === "PUBLIC_MEMPOOL") {
      drawCards(state, u.owner, 1);
      pushEvent(events, state, "DRAW", `${playerLabel(u.owner)} dobiera kartę (Public Mempool)`);
    }
  }
  for (const node of state.nodes) {
    for (const pid of [0, 1] as PlayerId[]) {
      const dyingStructures = node.structures[pid].filter((s) => s.alive && s.hp <= 0);
      for (const s of dyingStructures) {
        s.alive = false;
        pushEvent(events, state, "DEATH", `Struktura ${getCard(s.cardId).name} zniszczona na Węźle ${node.index + 1}`);
      }
      if (dyingStructures.length > 0) {
        node.structures[pid] = node.structures[pid].filter((s) => s.alive);
      }
    }
  }
}

function statusCleanup(state: MatchState, events: GameEvent[]) {
  for (const node of state.nodes) {
    for (const pid of [0, 1] as PlayerId[]) {
      for (const u of node.units[pid]) {
        if (!u.alive) continue;
        if (u.poison > 0) u.hp -= u.poison;
        if (u.overload > 0) u.overload -= 1;
        u.attackedPrevRound = u.attackedThisRound;
        u.attackedThisRound = false;
      }
    }
  }
  deathCheck(state, events);
}

/** Live per-node Hashpower (sum of effective ATK of alive own units) for both players —
 * used both for the final match resolution and for the live scoreboard in the UI. */
export function computeHashpower(state: MatchState): Record<PlayerId, [number, number, number]> {
  const hp: Record<PlayerId, [number, number, number]> = { 0: [0, 0, 0], 1: [0, 0, 0] };
  for (const node of state.nodes) {
    for (const pid of [0, 1] as PlayerId[]) {
      hp[pid][node.index] = ownUnits(state, node.index, pid).reduce((sum, u) => sum + effectiveAtk(state, u), 0);
    }
  }
  return hp;
}

export function resolveMatch(state: MatchState, forcedWinner?: PlayerId, reasonOverride?: MatchResult["reason"]): MatchResult {
  const hp = computeHashpower(state);
  const control: [PlayerId | null, PlayerId | null, PlayerId | null] = [null, null, null];
  for (let i = 0; i < 3; i++) {
    if (hp[0][i] > hp[1][i]) control[i] = 0;
    else if (hp[1][i] > hp[0][i]) control[i] = 1;
  }
  const nodesP0 = control.filter((c) => c === 0).length;
  const nodesP1 = control.filter((c) => c === 1).length;
  const total0 = hp[0].reduce((a, b) => a + b, 0);
  const total1 = hp[1].reduce((a, b) => a + b, 0);

  let winner: PlayerId | null;
  let reason: MatchResult["reason"];
  if (forcedWinner !== undefined) {
    winner = forcedWinner;
    reason = reasonOverride ?? "concede";
  } else if (nodesP0 >= 2) {
    winner = 0;
    reason = "control_2_nodes";
  } else if (nodesP1 >= 2) {
    winner = 1;
    reason = "control_2_nodes";
  } else if (total0 > total1) {
    winner = 0;
    reason = "total_hashpower_tiebreak";
  } else if (total1 > total0) {
    winner = 1;
    reason = "total_hashpower_tiebreak";
  } else {
    winner = null;
    reason = "draw";
  }

  return {
    winner,
    reason,
    hashpower: hp,
    nodesControl: control,
    total: [total0, total1],
    roundsPlayed: ROUNDS,
  };
}

function endOrdersSubPhase(state: MatchState, events: GameEvent[]) {
  if (state.phase === "ORDERS_ACTIVE") {
    state.phase = "ORDERS_INACTIVE";
    pushEvent(events, state, "PHASE", "Faza Rozkazów przeciwnika.");
  } else if (state.phase === "ORDERS_INACTIVE") {
    state.phase = "COMBAT_ACTIVE";
    pushEvent(events, state, "PHASE", "Faza Walki.");
  }
}

function endCombatSubPhase(state: MatchState, events: GameEvent[]) {
  if (state.phase === "COMBAT_ACTIVE") {
    deathCheck(state, events);
    state.phase = "COMBAT_INACTIVE";
  } else if (state.phase === "COMBAT_INACTIVE") {
    deathCheck(state, events);
    statusCleanup(state, events);
    if (state.roundNo >= ROUNDS) {
      state.result = resolveMatch(state);
      state.phase = "GAME_OVER";
      pushEvent(events, state, "GAME_OVER", matchResultMessage(state.result));
    } else {
      beginRound(state, state.roundNo + 1, events);
    }
  }
}

function matchResultMessage(result: MatchResult): string {
  if (result.winner === null) return "Remis!";
  return result.winner === 0 ? "Gracz wygrywa mecz!" : "Przeciwnik wygrywa mecz!";
}

/** Auto-advances phases where the acting player has zero legal actions (mirrors the Python
 * reference engine's `while legal: ...` loop terminating naturally). Runs in a bounded loop
 * since one empty phase can cascade into the next also being empty. */
function autoAdvanceEmptyPhases(state: MatchState, events: GameEvent[]) {
  let guard = 0;
  while (guard++ < 200) {
    const acting = getActingPlayer(state);
    if (acting === null) return;
    if (state.phase === "ORDERS_ACTIVE" || state.phase === "ORDERS_INACTIVE") {
      if (legalPlays(state, acting).length === 0) {
        endOrdersSubPhase(state, events);
        continue;
      }
    } else if (state.phase === "COMBAT_ACTIVE" || state.phase === "COMBAT_INACTIVE") {
      if (legalAttacks(state, acting).length === 0) {
        endCombatSubPhase(state, events);
        continue;
      }
    }
    return;
  }
}

export function applyAction(state: MatchState, action: Action): ActionResult {
  const clone = structuredClone(state);
  const events: GameEvent[] = [];

  const fail = (error: string): ActionResult => ({ state, events: [], error });

  if (action.type === "CONCEDE") {
    if (clone.phase === "GAME_OVER") return fail("Mecz już się zakończył.");
    clone.result = resolveMatch(clone, (1 - action.player) as PlayerId, "concede");
    clone.phase = "GAME_OVER";
    pushEvent(events, clone, "CONCEDE", `${playerLabel(action.player)} poddaje mecz.`);
    clone.events.push(...events);
    return { state: clone, events, error: null };
  }

  const acting = getActingPlayer(clone);
  if (acting === null) return fail("Mecz się zakończył, żadna akcja nie jest już legalna.");
  if (acting !== action.player) return fail("To nie jest teraz Twoja tura.");

  switch (action.type) {
    case "MULLIGAN": {
      if (clone.phase !== "MULLIGAN") return fail("Faza mulliganu już minęła.");
      const player = clone.players[action.player];
      for (const cid of action.cardIds) {
        const idx = player.hand.indexOf(cid);
        if (idx === -1) return fail(`Karta ${cid} nie jest w ręce.`);
        player.hand.splice(idx, 1);
        player.deck.push(cid);
      }
      if (action.cardIds.length > 0) {
        shuffleDeck(clone, action.player);
        drawCards(clone, action.player, action.cardIds.length);
      }
      clone.mulliganDone[action.player] = true;
      pushEvent(events, clone, "MULLIGAN", `${playerLabel(action.player)} wymienia ${action.cardIds.length} kart.`);
      if (clone.mulliganDone[0] && clone.mulliganDone[1]) {
        beginRound(clone, 1, events);
      }
      break;
    }
    case "PLAY_CARD": {
      if (clone.phase !== "ORDERS_ACTIVE" && clone.phase !== "ORDERS_INACTIVE") {
        return fail("Teraz nie jest Faza Rozkazów.");
      }
      const reason = whyIllegalPlay(clone, action.player, action.cardId, action.node);
      if (reason) return fail(reason);
      applyPlay(clone, action.player, action.cardId, action.node, events);
      deathCheck(clone, events);
      break;
    }
    case "PASS_ORDERS": {
      if (clone.phase !== "ORDERS_ACTIVE" && clone.phase !== "ORDERS_INACTIVE") {
        return fail("Teraz nie jest Faza Rozkazów.");
      }
      pushEvent(events, clone, "PASS", `${playerLabel(action.player)} kończy Fazę Rozkazów.`);
      endOrdersSubPhase(clone, events);
      break;
    }
    case "ATTACK": {
      if (clone.phase !== "COMBAT_ACTIVE" && clone.phase !== "COMBAT_INACTIVE") {
        return fail("Teraz nie jest Faza Walki.");
      }
      const reason = whyIllegalAttack(clone, action.player, action.attackerIid, action.targetIid);
      if (reason) return fail(reason);
      resolveAttack(clone, action.player, action.attackerIid, action.targetIid, events);
      break;
    }
    case "PASS_COMBAT": {
      if (clone.phase !== "COMBAT_ACTIVE" && clone.phase !== "COMBAT_INACTIVE") {
        return fail("Teraz nie jest Faza Walki.");
      }
      pushEvent(events, clone, "PASS", `${playerLabel(action.player)} kończy Fazę Walki.`);
      endCombatSubPhase(clone, events);
      break;
    }
    default:
      return fail("Nieznana akcja.");
  }

  autoAdvanceEmptyPhases(clone, events);
  clone.events.push(...events);
  return { state: clone, events, error: null };
}

function resolveAttack(state: MatchState, pid: PlayerId, attackerIid: string, targetIid: string, events: GameEvent[]) {
  const attacker = state.nodes.flatMap((n) => n.units[pid]).find((u) => u.iid === attackerIid)!;
  const opp = (1 - pid) as PlayerId;
  const targetNode = state.nodes[attacker.node];
  const target =
    targetNode.units[opp].find((u) => u.iid === targetIid) ?? targetNode.structures[opp].find((u) => u.iid === targetIid)!;

  const atkVal = effectiveAtk(state, attacker);
  if (target.shield) {
    target.shield = false;
  } else {
    target.hp -= atkVal;
  }
  attacker.attackedThisRound = true;
  pushEvent(events, state, "ATTACK", `${getCard(attacker.cardId).name} atakuje ${getCard(target.cardId).name} (${atkVal} obr.)`, {
    attackerIid,
    targetIid,
    damage: atkVal,
  });

  const targetAtk = effectiveAtk(state, target);
  const protectedAttacker = state.nodes[attacker.node].structures[attacker.owner].some(
    (s) => s.alive && s.hp > 0 && getCard(s.cardId).passive?.op === "NO_RETALIATION_DAMAGE_OWN_AT_NODE"
  );
  if (target.alive && target.hp > 0 && targetAtk > 0 && !attacker.keywords.has("RANGED") && !protectedAttacker) {
    if (attacker.shield) {
      attacker.shield = false;
    } else {
      attacker.hp -= targetAtk;
    }
    pushEvent(events, state, "RETALIATE", `${getCard(target.cardId).name} oddaje ${targetAtk} obrażeń.`);
  }

  if (attacker.keywords.has("PUMP") && !attacker.pumpUsed) {
    attacker.pumpUsed = true;
    attacker.atk += 1;
  }
}

export { getActingPlayer };
