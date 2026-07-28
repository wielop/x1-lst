"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { applyAction, computeHashpower, initMatch } from "@/game/engine";
import { Actions } from "@/game/actions";
import { runBotUntilHumanTurn } from "@/game/bot";
import { legalAttackTargets, legalPlays } from "@/game/validation";
import type { MatchState, NodeIndex, PlayerId, Unit } from "@/game/types";
import { NodeColumn } from "@/components/NodeColumn";
import { HandBar } from "@/components/HandBar";
import { trackEvent, updateSettings } from "@/lib/storage";

const HUMAN: PlayerId = 0;
const TUTORIAL_SEED = 424242;
const TUTORIAL_DECK = Array(20).fill("MIN-01"); // vanilla 1-cost unit, fully predictable
const BOT_DECK = Array(20).fill("DEG-01"); // vanilla 1-cost unit for the bot side

type StepId = "intro" | "hand" | "select" | "play" | "control" | "endOrders" | "attack" | "wrapup" | "done";

const STEPS: { id: StepId; text: string }[] = [
  { id: "intro", text: "Witaj w Node Clash! Plansza ma 3 Węzły Sieci. Kliknij „Dalej”, aby zacząć." },
  { id: "hand", text: "To jest Twoja ręka na dole ekranu. Każda karta pokazuje koszt (górny lewy róg) oraz ATK/HP." },
  { id: "select", text: "Kliknij kartę w ręce, żeby ją wybrać do zagrania." },
  { id: "play", text: "Teraz kliknij przycisk „Zagraj tutaj” pod Węzłem 1." },
  { id: "control", text: "Widzisz liczby przy węźle? To Hashpower obu stron — kto ma więcej, kontroluje węzeł. Kliknij „Dalej”." },
  { id: "endOrders", text: "Zagraj jeszcze 1-2 karty jeśli starczy Ci Gas, a potem kliknij „Zakończ Fazę Rozkazów”." },
  { id: "attack", text: "W następnej rundzie Twoja jednostka może już atakować. Kliknij ją, potem kliknij wroga na tym samym węźle." },
  { id: "wrapup", text: "Świetnie! Dalej gra toczy się tak samo przez 6 rund. Kliknij „Zakończ samouczek”." },
  { id: "done", text: "Ukończyłeś samouczek." },
];

export default function TutorialPage() {
  const [stepIndex, setStepIndex] = useState(0);
  const [state, setState] = useState<MatchState | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedAttacker, setSelectedAttacker] = useState<Unit | null>(null);
  const [playedOnce, setPlayedOnce] = useState(false);
  const [attackedOnce, setAttackedOnce] = useState(false);

  useEffect(() => {
    trackEvent("tutorial_start");
  }, []);

  // Safeguard: the scripted tutorial match can (rarely, with only 1-cost vanilla cards
  // repeatedly refilling the board) reach round 6 / GAME_OVER before the player happens to
  // get an attack opportunity the script is waiting for. Without this, the UI would be stuck
  // showing stale instructions with no legal actions left. Skip straight to the wrap-up.
  useEffect(() => {
    if (state?.phase === "GAME_OVER" && stepIndex < STEPS.findIndex((s) => s.id === "wrapup")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStepIndex(STEPS.findIndex((s) => s.id === "wrapup"));
    }
  }, [state?.phase, stepIndex]);

  const step = STEPS[stepIndex];

  function begin() {
    let s = initMatch(TUTORIAL_DECK, BOT_DECK, "MINERS", "DEGENS", TUTORIAL_SEED);
    s = applyAction(s, Actions.mulligan(HUMAN, [])).state;
    s = applyAction(s, Actions.mulligan(1, [])).state;
    setState(s);
    setStepIndex(1);
  }

  function advance() {
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  }

  function runBotAndSet(next: MatchState) {
    if (next.phase === "GAME_OVER") {
      setState(next);
      return;
    }
    const botRun = runBotUntilHumanTurn(next, HUMAN, "EASY");
    setState(botRun.state);
  }

  function onSelectHandCard(cardId: string) {
    setSelectedCardId((c) => (c === cardId ? null : cardId));
    if (step.id === "select") advance();
  }

  function onPlayAt(node: NodeIndex) {
    if (!state || !selectedCardId) return;
    const r = applyAction(state, Actions.playCard(HUMAN, selectedCardId, node));
    if (r.error) return;
    setSelectedCardId(null);
    setPlayedOnce(true);
    runBotAndSet(r.state);
    if (step.id === "play") setStepIndex(4); // -> control
  }

  function onSelectAttacker(u: Unit) {
    setSelectedAttacker((cur) => (cur?.iid === u.iid ? null : u));
  }

  function onSelectTarget(u: Unit) {
    if (!state || !selectedAttacker) return;
    const r = applyAction(state, Actions.attack(HUMAN, selectedAttacker.iid, u.iid));
    setSelectedAttacker(null);
    if (r.error) return;
    setAttackedOnce(true);
    runBotAndSet(r.state);
    if (step.id === "attack") advance();
  }

  function passOrders() {
    if (!state) return;
    const r = applyAction(state, Actions.passOrders(HUMAN));
    if (r.error) return;
    runBotAndSet(r.state);
    if (step.id === "endOrders" && playedOnce) advance();
  }

  function passCombat() {
    if (!state) return;
    const r = applyAction(state, Actions.passCombat(HUMAN));
    if (r.error) return;
    runBotAndSet(r.state);
  }

  function finishTutorial() {
    updateSettings({ tutorialCompleted: true });
    trackEvent("tutorial_complete");
    setStepIndex(STEPS.length - 1);
  }

  const hashpower = useMemo(() => (state ? computeHashpower(state) : null), [state]);
  const legalHandPlays = useMemo(() => (state ? legalPlays(state, HUMAN) : []), [state]);
  const playableCardIds = useMemo(() => new Set(legalHandPlays.map((m) => m.cardId)), [legalHandPlays]);
  const legalTargets = useMemo(
    () => (state && selectedAttacker ? legalAttackTargets(state, HUMAN, selectedAttacker) : []),
    [state, selectedAttacker]
  );
  const legalTargetIids = useMemo(() => new Set(legalTargets.map((t) => t.iid)), [legalTargets]);

  if (step.id === "intro" || !state || !hashpower) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-4 px-4 text-center">
        <h1 className="text-3xl font-extrabold">Samouczek</h1>
        <p className="text-[var(--text-dim)]">{STEPS[0].text}</p>
        <button onClick={begin} className="rounded bg-white px-6 py-3 font-bold text-black">
          Dalej
        </button>
        <Link href="/" className="text-xs text-[var(--text-dim)]">
          Pomiń samouczek
        </Link>
      </main>
    );
  }

  if (step.id === "done") {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-4 px-4 text-center">
        <h1 className="text-3xl font-extrabold text-green-400">Ukończono!</h1>
        <p className="text-[var(--text-dim)]">Rozumiesz już podstawy Node Clash. Czas na prawdziwy mecz.</p>
        <Link href="/play" className="rounded bg-white px-6 py-3 font-bold text-black">
          Zagraj z botem
        </Link>
        <Link href="/" className="text-xs text-[var(--text-dim)]">
          Strona główna
        </Link>
      </main>
    );
  }

  // Must account for BOTH the active AND inactive sub-phase (round parity alternates who is
  // active each round) — matching the same logic used in src/app/play/page.tsx. Missing the
  // "inactive" half here previously caused the pass buttons to silently disappear every other
  // round, a real bug caught by the Playwright tutorial-completion test.
  const isHumanOrders =
    (state.phase === "ORDERS_ACTIVE" && state.activePlayer === HUMAN) ||
    (state.phase === "ORDERS_INACTIVE" && state.activePlayer !== HUMAN);
  const isHumanCombat =
    (state.phase === "COMBAT_ACTIVE" && state.activePlayer === HUMAN) ||
    (state.phase === "COMBAT_INACTIVE" && state.activePlayer !== HUMAN);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-3 px-3 py-4">
      <div className="rounded-lg border-2 border-yellow-400 bg-yellow-950/30 p-3 text-sm">
        <b>Krok {stepIndex}/{STEPS.length - 2}:</b> {step.text}
        {(step.id === "hand" || step.id === "control") && (
          <button onClick={advance} className="ml-3 rounded bg-white px-2 py-0.5 text-xs font-semibold text-black">
            Dalej
          </button>
        )}
        {step.id === "wrapup" && (
          <button onClick={finishTutorial} className="ml-3 rounded bg-white px-2 py-0.5 text-xs font-semibold text-black">
            Zakończ samouczek
          </button>
        )}
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="font-bold">Runda {state.roundNo}/6 (samouczek)</span>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        {[0, 1, 2].map((n) => (
          <NodeColumn
            key={n}
            state={state}
            node={n as NodeIndex}
            humanPid={HUMAN}
            hashpower={hashpower}
            selectedAttacker={selectedAttacker}
            onSelectAttacker={onSelectAttacker}
            onSelectTarget={onSelectTarget}
            onPlayHere={() => onPlayAt(n as NodeIndex)}
            playableHere={!!selectedCardId && legalHandPlays.some((m) => m.cardId === selectedCardId && m.node === n)}
            legalTargetIids={legalTargetIids}
          />
        ))}
      </div>

      <HandBar
        handCardIds={state.players[HUMAN].hand}
        gas={state.players[HUMAN].gas}
        playableCardIds={playableCardIds}
        selectedCardId={selectedCardId}
        onSelect={onSelectHandCard}
      />

      <div className="flex gap-2">
        {isHumanOrders && (
          <button onClick={passOrders} className="flex-1 rounded bg-white/10 py-2 text-sm font-semibold">
            Zakończ Fazę Rozkazów
          </button>
        )}
        {isHumanCombat && (
          <button onClick={passCombat} className="flex-1 rounded bg-white/10 py-2 text-sm font-semibold">
            Zakończ atakowanie
          </button>
        )}
      </div>
      {attackedOnce && step.id !== "wrapup" && step.id !== "attack" && (
        <button onClick={() => setStepIndex(STEPS.findIndex((s) => s.id === "wrapup"))} className="text-xs text-[var(--text-dim)] underline">
          Przejdź dalej
        </button>
      )}
    </main>
  );
}
