// Bot AI for PvE matches. Three difficulty levels, all driven through the same public
// `applyAction` gate as a human player — the bot cannot bypass rules and can only read
// PUBLIC information (its own hand + both players' board state). It never reads the
// opponent's hand contents or deck order.
import { getCard } from "./cards";
import { applyAction, getActingPlayer } from "./engine";
import { legalAttacks, legalAttackTargets, legalPlays } from "./validation";
import type { Action, LegalPlay, MatchState, PlayerId, Unit } from "./types";

export type BotDifficulty = "EASY" | "NORMAL" | "HARD";

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Returns the single next action the bot wants to take right now, given the current phase.
 * Call repeatedly (feeding each result through applyAction) until the acting player is no
 * longer the bot. */
export function chooseBotAction(state: MatchState, pid: PlayerId, difficulty: BotDifficulty): Action {
  if (state.phase === "MULLIGAN") return chooseMulligan(state, pid, difficulty);
  if (state.phase === "ORDERS_ACTIVE" || state.phase === "ORDERS_INACTIVE") {
    return chooseOrdersAction(state, pid, difficulty);
  }
  return chooseCombatAction(state, pid, difficulty);
}

function chooseMulligan(state: MatchState, pid: PlayerId, difficulty: BotDifficulty): Action {
  const hand = state.players[pid].hand;
  if (difficulty === "EASY") {
    const cardIds = hand.filter(() => Math.random() < 0.3);
    return { type: "MULLIGAN", player: pid, cardIds };
  }
  const expensive = hand.filter((cid) => getCard(cid).cost >= 5);
  const maxMull = Math.max(0, hand.length - 2);
  return { type: "MULLIGAN", player: pid, cardIds: expensive.slice(0, maxMull) };
}

function scoreMove(state: MatchState, pid: PlayerId, move: LegalPlay): number {
  const card = getCard(move.cardId);
  const node = state.nodes[move.node];
  const own = node.units[pid].filter((u) => u.alive && u.hp > 0);
  let score = card.cost * 2;
  if (card.type === "UNIT") {
    score -= own.length;
    if (card.keywords.includes("SYNERGY")) {
      const sameFaction = own.filter((u) => getCard(u.cardId).faction === card.faction).length;
      score += sameFaction * 3;
    }
  } else if (card.type === "ACTION") {
    const opp = (1 - pid) as PlayerId;
    const enemies = node.units[opp].filter((u) => u.alive && u.hp > 0);
    score += enemies.length > 0 ? 3 : -5;
  } else if (card.type === "STRUCTURE") {
    score += 1;
  }
  return score;
}

function chooseOrdersAction(state: MatchState, pid: PlayerId, difficulty: BotDifficulty): Action {
  const moves = legalPlays(state, pid);
  if (moves.length === 0) return { type: "PASS_ORDERS", player: pid };

  if (difficulty === "EASY") {
    if (Math.random() < 0.15) return { type: "PASS_ORDERS", player: pid };
    const m = pick(moves);
    return { type: "PLAY_CARD", player: pid, cardId: m.cardId, node: m.node };
  }

  if (difficulty === "NORMAL") {
    const scored = moves.map((m) => ({ m, s: scoreMove(state, pid, m) }));
    scored.sort((a, b) => b.s - a.s);
    if (scored[0].s < -3) return { type: "PASS_ORDERS", player: pid };
    return { type: "PLAY_CARD", player: pid, cardId: scored[0].m.cardId, node: scored[0].m.node };
  }

  // HARD: 1-ply lookahead — actually apply each candidate move and compare the resulting
  // live Hashpower advantage (own total minus opponent total across all 3 nodes).
  let best: { m: LegalPlay; adv: number } | null = null;
  for (const m of moves) {
    const result = applyAction(state, { type: "PLAY_CARD", player: pid, cardId: m.cardId, node: m.node });
    if (result.error) continue;
    const adv = hashpowerAdvantage(result.state, pid);
    if (best === null || adv > best.adv) best = { m, adv };
  }
  if (!best) return { type: "PASS_ORDERS", player: pid };
  // Small chance to also just keep going with the plain heuristic pick to avoid the bot
  // being too easily "solved" by always taking the single best-looking greedy line.
  return { type: "PLAY_CARD", player: pid, cardId: best.m.cardId, node: best.m.node };
}

function hashpowerAdvantage(state: MatchState, pid: PlayerId): number {
  const opp = (1 - pid) as PlayerId;
  let own = 0;
  let enemy = 0;
  for (const node of state.nodes) {
    for (const u of node.units[pid]) if (u.alive && u.hp > 0) own += u.atk;
    for (const u of node.units[opp]) if (u.alive && u.hp > 0) enemy += u.atk;
  }
  return own - enemy;
}

function chooseCombatAction(state: MatchState, pid: PlayerId, difficulty: BotDifficulty): Action {
  const attacks = legalAttacks(state, pid);
  if (attacks.length === 0) return { type: "PASS_COMBAT", player: pid };

  if (difficulty === "EASY") {
    if (Math.random() < 0.3) return { type: "PASS_COMBAT", player: pid };
    const a = pick(attacks);
    return { type: "ATTACK", player: pid, attackerIid: a.attackerIid, targetIid: a.targetIid };
  }

  // NORMAL + HARD both start from "prefer a safe kill, then a survivable trade" — mirrors
  // the reference Python GreedyAgent. HARD additionally breaks ties by simulating the
  // resulting Hashpower swing at that node.
  const attackers = uniqueAttackers(state, pid);
  for (const attackerIid of attackers) {
    const attacker = findUnit(state, pid, attackerIid);
    if (!attacker) continue;
    const targets = legalAttackTargets(state, pid, attacker);
    if (targets.length === 0) continue;

    const safeKills = targets.filter((t) => attacker.atk >= t.hp);
    if (safeKills.length > 0) {
      const target =
        difficulty === "HARD"
          ? bestByLookahead(state, pid, attackerIid, safeKills)
          : safeKills.reduce((a, b) => (b.atk > a.atk ? b : a));
      return { type: "ATTACK", player: pid, attackerIid, targetIid: target.iid };
    }
    const survivable = targets.filter((t) => attacker.hp > t.atk);
    if (survivable.length > 0 && attacker.atk >= 1) {
      const target =
        difficulty === "HARD"
          ? bestByLookahead(state, pid, attackerIid, survivable)
          : survivable.reduce((a, b) => (b.atk > a.atk ? b : a));
      return { type: "ATTACK", player: pid, attackerIid, targetIid: target.iid };
    }
  }
  return { type: "PASS_COMBAT", player: pid };
}

function bestByLookahead(state: MatchState, pid: PlayerId, attackerIid: string, targets: Unit[]): Unit {
  let best = targets[0];
  let bestAdv = -Infinity;
  for (const t of targets) {
    const result = applyAction(state, { type: "ATTACK", player: pid, attackerIid, targetIid: t.iid });
    if (result.error) continue;
    const adv = hashpowerAdvantage(result.state, pid);
    if (adv > bestAdv) {
      bestAdv = adv;
      best = t;
    }
  }
  return best;
}

function uniqueAttackers(state: MatchState, pid: PlayerId): string[] {
  const ids = new Set<string>();
  for (const node of state.nodes) for (const u of node.units[pid]) ids.add(u.iid);
  return [...ids];
}

function findUnit(state: MatchState, pid: PlayerId, iid: string): Unit | undefined {
  for (const node of state.nodes) {
    const u = node.units[pid].find((x) => x.iid === iid);
    if (u) return u;
  }
  return undefined;
}

/** Runs the bot's entire current phase (repeated actions) until control returns to the
 * other player or the match ends. Safe to call after every human action. */
export function runBotUntilHumanTurn(
  state: MatchState,
  humanPid: PlayerId,
  difficulty: BotDifficulty
): { state: MatchState; events: MatchState["events"]; actions: Action[] } {
  let current = state;
  const allEvents: MatchState["events"] = [];
  const allActions: Action[] = [];
  let guard = 0;
  while (guard++ < 500) {
    const acting = getActingPlayer(current);
    if (acting === null || acting === humanPid) break;
    const action = chooseBotAction(current, acting, difficulty);
    const result = applyAction(current, action);
    if (result.error) {
      // Should not happen (bot only picks from legal move lists) — fail safe by passing.
      const fallback: Action =
        current.phase === "MULLIGAN"
          ? { type: "MULLIGAN", player: acting, cardIds: [] }
          : current.phase === "ORDERS_ACTIVE" || current.phase === "ORDERS_INACTIVE"
            ? { type: "PASS_ORDERS", player: acting }
            : { type: "PASS_COMBAT", player: acting };
      const safeResult = applyAction(current, fallback);
      current = safeResult.state;
      allEvents.push(...safeResult.events);
      allActions.push(fallback);
      continue;
    }
    current = result.state;
    allEvents.push(...result.events);
    allActions.push(action);
  }
  return { state: current, events: allEvents, actions: allActions };
}
