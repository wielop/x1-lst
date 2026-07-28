import { getCard } from "./cards";
import { GAS_HARD_CAP } from "./constants";
import type { EffectSpec, GameEvent, MatchState, NodeIndex, PlayerId, Unit } from "./types";
import { drawCards, rngChoice } from "./engine-rng";

export function ownUnits(state: MatchState, node: NodeIndex, pid: PlayerId): Unit[] {
  return state.nodes[node].units[pid].filter((u) => u.alive && u.hp > 0);
}

export function enemyUnits(state: MatchState, node: NodeIndex, pid: PlayerId): Unit[] {
  const opp = (1 - pid) as PlayerId;
  return state.nodes[node].units[opp].filter((u) => u.alive && u.hp > 0);
}

export function enemyStructures(state: MatchState, node: NodeIndex, pid: PlayerId): Unit[] {
  const opp = (1 - pid) as PlayerId;
  return state.nodes[node].structures[opp].filter((u) => u.alive && u.hp > 0);
}

export function enemyCombatTargets(state: MatchState, node: NodeIndex, pid: PlayerId): Unit[] {
  return [...enemyUnits(state, node, pid), ...enemyStructures(state, node, pid)];
}

export function synergyCount(
  state: MatchState,
  node: NodeIndex,
  pid: PlayerId,
  source: Unit | null,
  faction: string
): number {
  return ownUnits(state, node, pid).filter(
    (u) => getCard(u.cardId).faction === faction && (source === null || u.iid !== source.iid)
  ).length;
}

export function effectiveAtk(state: MatchState, unit: Unit): number {
  if (!unit.alive || unit.hp <= 0) return 0;
  let atk = unit.atk;
  const node = state.nodes[unit.node];
  for (const s of node.structures[unit.owner]) {
    if (!(s.alive && s.hp > 0)) continue;
    const p = getCard(s.cardId).passive;
    if (p && p.op === "AURA_ATK_FACTION" && getCard(unit.cardId).faction === p.faction) {
      atk += p.amount ?? 0;
    }
  }
  for (const other of ownUnits(state, unit.node, unit.owner)) {
    if (other.iid === unit.iid) continue;
    const p = getCard(other.cardId).passive;
    if (p && p.op === "AURA_ATK_FACTION" && getCard(unit.cardId).faction === p.faction) {
      atk += p.amount ?? 0;
    }
  }
  const selfPassive = getCard(unit.cardId).passive;
  if (selfPassive && selfPassive.op === "SYNERGY_ATK_SELF") {
    atk += (selfPassive.amount ?? 0) * synergyCount(state, unit.node, unit.owner, unit, getCard(unit.cardId).faction);
  }
  return Math.max(0, atk);
}

export function protectedFromRetaliation(state: MatchState, unit: Unit): boolean {
  const node = state.nodes[unit.node];
  return node.structures[unit.owner].some(
    (s) => s.alive && s.hp > 0 && getCard(s.cardId).passive?.op === "NO_RETALIATION_DAMAGE_OWN_AT_NODE"
  );
}

export function dealDamage(unit: Unit, amount: number): void {
  if (amount <= 0) return;
  if (unit.shield) {
    unit.shield = false;
    return;
  }
  unit.hp -= amount;
}

function pickEnemyBest(state: MatchState, node: NodeIndex, pid: PlayerId): Unit | null {
  const enemies = enemyUnits(state, node, pid);
  if (enemies.length === 0) return null;
  return enemies.reduce((best, u) => (u.atk > best.atk || (u.atk === best.atk && u.hp < best.hp) ? u : best));
}

function pickOwnBest(state: MatchState, node: NodeIndex, pid: PlayerId, exclude: Unit | null): Unit | null {
  const owns = ownUnits(state, node, pid).filter((u) => u !== exclude);
  if (owns.length === 0) return null;
  return owns.reduce((best, u) => (u.atk > best.atk || (u.atk === best.atk && u.hp > best.hp) ? u : best));
}

export function resolveEffect(
  state: MatchState,
  pid: PlayerId,
  node: NodeIndex,
  spec: EffectSpec,
  source: Unit | null,
  events: GameEvent[]
): void {
  const player = state.players[pid];
  const nodeState = state.nodes[node];
  switch (spec.op) {
    case "GAIN_GAS":
      player.gas = Math.min(player.gas + (spec.amount ?? 0), GAS_HARD_CAP);
      break;
    case "DRAW":
      drawCards(state, pid, spec.amount ?? 0);
      break;
    case "DRAW_AND_GAS":
      drawCards(state, pid, spec.draw ?? 0);
      player.gas = Math.min(player.gas + (spec.gas ?? 0), GAS_HARD_CAP);
      break;
    case "BURN": {
      const target = pickEnemyBest(state, node, pid);
      if (target) dealDamage(target, spec.amount ?? 0);
      break;
    }
    case "BURN_WITH_GAS_ON_KILL": {
      const target = pickEnemyBest(state, node, pid);
      if (target) {
        dealDamage(target, spec.amount ?? 0);
        if (target.hp <= 0) player.gas = Math.min(player.gas + (spec.gas_on_kill ?? 0), GAS_HARD_CAP);
      }
      break;
    }
    case "POISON": {
      const target = pickEnemyBest(state, node, pid);
      if (target) target.poison += spec.amount ?? 0;
      break;
    }
    case "OVERLOAD": {
      const target = pickEnemyBest(state, node, pid);
      if (target) target.overload = Math.max(target.overload, spec.amount ?? 0);
      break;
    }
    case "FREEZE": {
      const target = pickEnemyBest(state, node, pid);
      if (target) target.frozen = true;
      break;
    }
    case "DAMAGE_ALL_ENEMIES_AT_NODE":
      for (const u of enemyUnits(state, node, pid)) dealDamage(u, spec.amount ?? 0);
      break;
    case "BUFF_ATK": {
      const target = pickOwnBest(state, node, pid, source) ?? source;
      if (target) target.atk += spec.amount ?? 0;
      break;
    }
    case "SHIELD_AND_BUFF_HP": {
      const target = pickOwnBest(state, node, pid, source) ?? source;
      if (target) {
        target.shield = true;
        target.hp += spec.hp ?? 0;
      }
      break;
    }
    case "GRANT_SHIELD": {
      const target = pickOwnBest(state, node, pid, source) ?? source;
      if (target) target.shield = true;
      break;
    }
    case "GRANT_SHIELD_ALL_OWN_AT_NODE":
      for (const u of ownUnits(state, node, pid)) u.shield = true;
      break;
    case "DESTROY_IF": {
      const target = pickEnemyBest(state, node, pid);
      if (target && spec.condition === "atk_lte" && target.atk <= (spec.value ?? 0)) target.hp = 0;
      break;
    }
    case "DESTROY_AND_SHIELD": {
      const target = pickEnemyBest(state, node, pid);
      if (target) target.hp = 0;
      const friend = pickOwnBest(state, node, pid, null);
      if (friend) friend.shield = true;
      break;
    }
    case "SHIELD_IF_SYNERGY": {
      const count = synergyCount(state, node, pid, source, "BUILDERS");
      if (source && count >= (spec.min_synergy ?? 0)) source.shield = true;
      break;
    }
    case "BURN_SYNERGY": {
      const count = synergyCount(state, node, pid, source, "BUILDERS");
      const base = spec.base ?? 0;
      const amount = count > 0 ? Math.max(base, count) : base;
      const target = pickEnemyBest(state, node, pid);
      if (target) dealDamage(target, amount);
      break;
    }
    case "DRAW_SYNERGY": {
      const count = synergyCount(state, node, pid, source, "BUILDERS");
      const n = Math.min(Math.floor(count / (spec.per ?? 1)), spec.max_draw ?? 0);
      if (n > 0) drawCards(state, pid, n);
      break;
    }
    case "SACRIFICE_OWN_DRAW_GAS": {
      const target = pickOwnBest(state, node, pid, source);
      if (target) {
        target.hp = 0;
        player.gas = Math.min(player.gas + (spec.gas ?? 0), GAS_HARD_CAP);
        drawCards(state, pid, spec.draw ?? 0);
      }
      break;
    }
    case "BOUNCE_OWN_DRAW_GAS": {
      const target = pickOwnBest(state, node, pid, source);
      if (target) {
        target.hp = 0;
        target.alive = false;
        nodeState.units[pid] = nodeState.units[pid].filter((u) => u.iid !== target.iid);
        player.hand.push(target.cardId);
        player.gas = Math.min(player.gas + (spec.gas ?? 0), GAS_HARD_CAP);
        drawCards(state, pid, spec.draw ?? 0);
      }
      break;
    }
    case "RETURN_RANDOM_FROM_GRAVEYARD": {
      const count = synergyCount(state, node, pid, source, "BUILDERS");
      if (count >= (spec.min_synergy ?? 0)) {
        const pool = player.graveyard.filter((cid) => getCard(cid).faction === "BUILDERS");
        if (pool.length > 0) {
          const pick = rngChoice(state, pool);
          const idx = player.graveyard.indexOf(pick);
          if (idx >= 0) player.graveyard.splice(idx, 1);
          player.hand.push(pick);
        }
      }
      break;
    }
    case "BUFF_ATK_HP_ALL_OWN_FACTION_AT_NODE":
      for (const u of ownUnits(state, node, pid)) {
        if (getCard(u.cardId).faction === "BUILDERS") {
          u.atk += spec.atk ?? 0;
          u.hp += spec.hp ?? 0;
        }
      }
      break;
    default:
      throw new Error(`Unknown effect op: ${spec.op}`);
  }
  events.push({
    round: state.roundNo,
    type: "EFFECT",
    message: `${spec.op}`,
    data: { pid, node, spec: spec.op },
  });
}
