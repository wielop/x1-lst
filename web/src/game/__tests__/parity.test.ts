// Cross-language parity tests: fixed fixtures whose EXPECTED values were computed by
// actually running the Python reference engine (sim/engine.py, with patch_v1+v2+v3 applied)
// on equivalent inputs — see /home/wielop/x1-card-arena/sim/parity_check.py and its output
// sim/results/parity_expected.json. These are not "what I think the rules say" assertions;
// each expected number below was produced by executing the reference implementation.
import { describe, expect, it } from "vitest";
import { initMatch, resolveMatch, applyAction } from "../engine";
import { effectiveAtk } from "../effects";
import { congestionFee, costOf } from "../validation";
import { getCard } from "../cards";
import { Actions } from "../actions";
import type { NodeIndex, PlayerId, Unit } from "../types";

function homogeneousDeck(cardId: string, n = 20): string[] {
  return Array(n).fill(cardId);
}

function makeUnit(cardId: string, owner: PlayerId, node: NodeIndex, overrides: Partial<Unit> = {}): Unit {
  const c = getCard(cardId);
  return {
    iid: `parity-${cardId}-${owner}-${Math.random()}`,
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
    enteredRound: 0,
    attackedThisRound: false,
    attackedPrevRound: false,
    pumpUsed: false,
    alive: true,
    ...overrides,
  };
}

describe("parity vs. Python reference engine (sim/parity_check.py output)", () => {
  it("congestion fee: 2nd unit at an occupied node costs base+1 — Python: fee=1, cost=2", () => {
    const state = initMatch(homogeneousDeck("MIN-01"), homogeneousDeck("DEG-01"), "MINERS", "DEGENS", 1);
    state.nodes[0].units[0] = [makeUnit("MIN-01", 0, 0)];
    expect(congestionFee(state, 0, 0)).toBe(1);
    expect(costOf(state, 0, "MIN-01", 0)).toBe(2);
  });

  it("FAST_LANE (node 0): entering unit gets permanent +1 ATK — Python: base=1, after=2", () => {
    const before = getCard("MIN-01").atk!;
    expect(before).toBe(1);
    const state = initMatch(homogeneousDeck("MIN-01"), homogeneousDeck("DEG-01"), "MINERS", "DEGENS", 1);
    const s1 = applyAction(state, Actions.mulligan(0, [])).state;
    const s2 = applyAction(s1, Actions.mulligan(1, [])).state;
    const played = applyAction(s2, Actions.playCard(0, "MIN-01", 0));
    expect(played.error).toBeNull();
    expect(played.state.nodes[0].units[0][0].atk).toBe(before + 1);
  });

  it("COLD_STORAGE (node 1): entering unit gets Shield — Python: shield=true", () => {
    let state = initMatch(homogeneousDeck("MIN-01"), homogeneousDeck("DEG-01"), "MINERS", "DEGENS", 1);
    state = applyAction(state, Actions.mulligan(0, [])).state;
    state = applyAction(state, Actions.mulligan(1, [])).state;
    const played = applyAction(state, Actions.playCard(0, "MIN-01", 1));
    expect(played.state.nodes[1].units[0][0].shield).toBe(true);
  });

  it("resolveMatch control_2_nodes — Python: winner=0, nodes_control=[P0,P0,P1], total=[6,3]", () => {
    const state = initMatch(homogeneousDeck("MIN-01"), homogeneousDeck("DEG-01"), "MINERS", "DEGENS", 1);
    state.nodes[0].units[0] = [makeUnit("DEG-08", 0, 0, { atk: 3 })];
    state.nodes[1].units[0] = [makeUnit("DEG-08", 0, 1, { atk: 3 })];
    state.nodes[2].units[1] = [makeUnit("DEG-08", 1, 2, { atk: 3 })];
    const result = resolveMatch(state);
    expect(result.winner).toBe(0);
    expect(result.reason).toBe("control_2_nodes");
    expect(result.nodesControl).toEqual([0, 0, 1]); // TS encodes control as playerId|null, Python as -1/1/0
    expect(result.total).toEqual([6, 3]);
  });

  it("resolveMatch total_hashpower_tiebreak — Python: winner=0, total=[7,3]", () => {
    const state = initMatch(homogeneousDeck("MIN-01"), homogeneousDeck("DEG-01"), "MINERS", "DEGENS", 1);
    state.nodes[0].units[0] = [makeUnit("DEG-12", 0, 0, { atk: 7 })];
    state.nodes[1].units[1] = [makeUnit("DEG-08", 1, 1, { atk: 3 })];
    const result = resolveMatch(state);
    expect(result.winner).toBe(0);
    expect(result.reason).toBe("total_hashpower_tiebreak");
    expect(result.total).toEqual([7, 3]);
  });

  it("resolveMatch draw — Python: winner=null, total=[3,3]", () => {
    const state = initMatch(homogeneousDeck("MIN-01"), homogeneousDeck("DEG-01"), "MINERS", "DEGENS", 1);
    state.nodes[0].units[0] = [makeUnit("DEG-08", 0, 0, { atk: 3 })];
    state.nodes[1].units[1] = [makeUnit("DEG-08", 1, 1, { atk: 3 })];
    const result = resolveMatch(state);
    expect(result.winner).toBeNull();
    expect(result.total).toEqual([3, 3]);
  });

  it("SYNERGY_ATK_SELF (DAO Council) — Python: base_atk=3, effective_atk_with_1_ally=5", () => {
    const state = initMatch(homogeneousDeck("BLD-01"), homogeneousDeck("DEG-01"), "BUILDERS", "DEGENS", 1);
    const dao = makeUnit("BLD-09", 0, 0);
    const ally = makeUnit("BLD-01", 0, 0);
    state.nodes[0].units[0] = [dao, ally];
    expect(dao.atk).toBe(3);
    expect(effectiveAtk(state, dao)).toBe(5);
  });

  it("AURA_ATK_FACTION (Smart Contract) — Python: buffed base=1, effective=3; enemy unaffected=2", () => {
    const state = initMatch(homogeneousDeck("BLD-01"), homogeneousDeck("VAL-01"), "BUILDERS", "VALIDATORS", 1);
    const structure = makeUnit("BLD-03", 0, 0);
    const buffed = makeUnit("BLD-01", 0, 0);
    const enemy = makeUnit("VAL-01", 1, 0);
    state.nodes[0].structures[0] = [structure];
    state.nodes[0].units[0] = [buffed];
    state.nodes[0].units[1] = [enemy];
    expect(buffed.atk).toBe(1);
    expect(effectiveAtk(state, buffed)).toBe(3);
    expect(effectiveAtk(state, enemy)).toBe(2);
  });

  it("GUARD forces the attack, killed Guard gives no retaliation, non-Guard untouched — matches Python exactly", () => {
    const state = initMatch(homogeneousDeck("DEG-08"), homogeneousDeck("VAL-02"), "DEGENS", "VALIDATORS", 1);
    state.roundNo = 3;
    state.phase = "COMBAT_ACTIVE";
    state.activePlayer = 0;
    const attacker = makeUnit("DEG-08", 0, 0); // atk3/hp3
    const guard = makeUnit("VAL-02", 1, 0); // atk1/hp1, GUARD
    const nonGuard = makeUnit("VAL-01", 1, 0); // atk2/hp2
    state.nodes[0].units[0] = [attacker];
    state.nodes[0].units[1] = [nonGuard, guard];
    const result = applyAction(state, Actions.attack(0, attacker.iid, guard.iid));
    expect(result.error).toBeNull();
    const survivingGuard = result.state.nodes[0].units[1].find((u) => u.iid === guard.iid);
    const survivingNonGuard = result.state.nodes[0].units[1].find((u) => u.iid === nonGuard.iid)!;
    expect(survivingGuard).toBeUndefined(); // dead (hp 1-3=-2), removed
    expect(survivingNonGuard.hp).toBe(2); // Python: nonguard_hp_after=2, untouched
    const survivingAttacker = result.state.nodes[0].units[0].find((u) => u.iid === attacker.iid)!;
    expect(survivingAttacker.hp).toBe(3); // Python: attacker_hp_after=3 — dead Guard doesn't retaliate
  });

  it("Shield absorbs exactly one hit regardless of size — Python: hp_after=2 (unchanged), shield_after=false", () => {
    const state = initMatch(homogeneousDeck("VAL-01"), homogeneousDeck("DEG-01"), "VALIDATORS", "DEGENS", 1);
    const unit = makeUnit("VAL-01", 0, 0, { shield: true });
    expect(unit.hp).toBe(2);
    // Reuse the engine's own dealDamage indirectly via an attack fixture.
    state.roundNo = 3;
    state.phase = "COMBAT_ACTIVE";
    state.activePlayer = 1;
    const attacker = makeUnit("DEG-12", 1, 0); // huge ATK — Python test used amount=5 directly
    state.nodes[0].units[0] = [unit];
    state.nodes[0].units[1] = [attacker];
    const result = applyAction(state, Actions.attack(1, attacker.iid, unit.iid));
    const survivor = result.state.nodes[0].units[0].find((u) => u.iid === unit.iid)!;
    expect(survivor.hp).toBe(2); // fully absorbed, no damage at all
    expect(survivor.shield).toBe(false); // consumed
  });
});
