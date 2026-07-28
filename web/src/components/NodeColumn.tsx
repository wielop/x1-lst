"use client";
import type { MatchState, NodeIndex, PlayerId, Unit } from "@/game/types";
import { UnitChip } from "./UnitChip";

const PASSIVE_LABEL: Record<string, string> = {
  FAST_LANE: "Fast Lane · +1 ATK przy wejściu",
  COLD_STORAGE: "Cold Storage · Tarcza przy wejściu",
  PUBLIC_MEMPOOL: "Public Mempool · dobierz kartę gdy Twoja jednostka tu zginie",
};

export function NodeColumn({
  state,
  node,
  humanPid,
  hashpower,
  selectedAttacker,
  onSelectAttacker,
  onSelectTarget,
  onPlayHere,
  playableHere,
  legalTargetIids,
}: {
  state: MatchState;
  node: NodeIndex;
  humanPid: PlayerId;
  hashpower: Record<PlayerId, [number, number, number]>;
  selectedAttacker: Unit | null;
  onSelectAttacker: (u: Unit) => void;
  onSelectTarget: (u: Unit) => void;
  onPlayHere: () => void;
  playableHere: boolean;
  legalTargetIids: Set<string>;
}) {
  const opp = (1 - humanPid) as PlayerId;
  const ns = state.nodes[node];
  const ownHp = hashpower[humanPid][node];
  const enemyHp = hashpower[opp][node];
  const control = ownHp === enemyHp ? "sporny" : ownHp > enemyHp ? "Ty" : "Przeciwnik";

  const enemyUnits = [...ns.structures[opp], ...ns.units[opp]];
  const ownUnits = [...ns.units[humanPid], ...ns.structures[humanPid]];

  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] p-2">
      <div className="text-center text-xs font-bold">Węzeł {node + 1}</div>
      <div className="text-center text-[9px] text-[var(--text-dim)]">{PASSIVE_LABEL[ns.passive]}</div>
      <div className="mt-1 text-center text-[11px]">
        <span className="text-red-400">{enemyHp}</span> vs <span className="text-green-400">{ownHp}</span>
        <span className="ml-1 text-[var(--text-dim)]">({control})</span>
      </div>

      <div className="mt-2 flex min-h-16 flex-wrap justify-center gap-1">
        {enemyUnits.length === 0 && <span className="text-[10px] text-[var(--text-dim)]">—</span>}
        {enemyUnits.map((u) => (
          <UnitChip
            key={u.iid}
            unit={u}
            onClick={selectedAttacker && legalTargetIids.has(u.iid) ? () => onSelectTarget(u) : undefined}
            isTarget={selectedAttacker !== null && legalTargetIids.has(u.iid)}
          />
        ))}
      </div>

      <div className="my-2 border-t border-dashed border-[var(--border)]" />

      <div className="flex min-h-16 flex-wrap justify-center gap-1">
        {ownUnits.length === 0 && <span className="text-[10px] text-[var(--text-dim)]">—</span>}
        {ownUnits.map((u) => (
          <UnitChip
            key={u.iid}
            unit={u}
            selected={selectedAttacker?.iid === u.iid}
            onClick={!u.isStructure ? () => onSelectAttacker(u) : undefined}
            selectable={!u.isStructure}
          />
        ))}
      </div>

      {playableHere && (
        <button
          onClick={onPlayHere}
          className="mt-2 rounded bg-white py-1 text-xs font-semibold text-black hover:bg-white/90"
        >
          Zagraj tutaj
        </button>
      )}
    </div>
  );
}
