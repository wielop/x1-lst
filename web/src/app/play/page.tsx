"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CARDS_BY_ID } from "@/game/cards";
import { FACTIONS, STARTER_DECK_META, starterDeck } from "@/game/decks";
import { applyAction, computeHashpower, initMatch } from "@/game/engine";
import { Actions } from "@/game/actions";
import { runBotUntilHumanTurn, type BotDifficulty } from "@/game/bot";
import { legalAttackTargets, legalPlays, whyIllegalPlay } from "@/game/validation";
import type { Faction, MatchState, NodeIndex, PlayerId, Unit } from "@/game/types";
import { createReplayRecorder, exportReplayJson, finalizeReplay, recordAction, type Replay } from "@/game/replay";
import { factionTheme } from "@/lib/factionTheme";
import { loadSavedDecks, trackEvent, type SavedDeck } from "@/lib/storage";
import { NodeColumn } from "@/components/NodeColumn";
import { HandBar } from "@/components/HandBar";
import { EventLog } from "@/components/EventLog";
import { MatchResultScreen } from "@/components/MatchResultScreen";

type Stage = "setup" | "mulligan" | "match" | "result";
const HUMAN: PlayerId = 0;
const BOT_DIFFICULTIES: BotDifficulty[] = ["EASY", "NORMAL", "HARD"];
const BOT_LABEL: Record<BotDifficulty, string> = { EASY: "Łatwy", NORMAL: "Normalny", HARD: "Trudny" };

export default function PlayPage() {
  const [stage, setStage] = useState<Stage>("setup");
  const [factionChoice, setFactionChoice] = useState<Faction>("MINERS");
  const [savedDecks, setSavedDecks] = useState<SavedDeck[]>([]);
  const [savedDeckId, setSavedDeckId] = useState<string | null>(null);
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty>("NORMAL");

  const [state, setState] = useState<MatchState | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [mulliganSelection, setMulliganSelection] = useState<Set<string>>(new Set());
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedAttacker, setSelectedAttacker] = useState<Unit | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [matchStartTs, setMatchStartTs] = useState(0);
  const [matchEndTs, setMatchEndTs] = useState(0);

  // Hydrating client-only state (localStorage decks, ?savedDeck= query param) on mount is the
  // standard React idiom for browser-only data; the new react-hooks/set-state-in-effect rule
  // (experimental, part of the React Compiler tooling shipped with eslint-config-next 16) flags
  // it regardless. Documented, narrow suppression — not a real correctness issue: this effect
  // only ever runs once (empty deps) and cannot cascade.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSavedDecks(loadSavedDecks().decks);
    const params = new URLSearchParams(window.location.search);
    const sd = params.get("savedDeck");
    if (sd) setSavedDeckId(sd);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  function humanDeck(): { deck: string[]; faction: Faction } {
    const saved = savedDecks.find((d) => d.id === savedDeckId);
    if (saved) return { deck: saved.cardIds, faction: saved.faction };
    return { deck: starterDeck(factionChoice), faction: factionChoice };
  }

  function startMatch() {
    const { deck: deckA, faction: facA } = humanDeck();
    // Optional ?seed= and ?botFaction= query params make matches reproducible for E2E tests
    // and bug reports — harmless no-op for normal players (seed defaults to random).
    const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    const seedParam = params?.get("seed");
    const botFactionParam = params?.get("botFaction") as Faction | null;
    const botFaction = botFactionParam ?? FACTIONS[Math.floor(Math.random() * FACTIONS.length)];
    const deckB = starterDeck(botFaction);
    const seed = seedParam ? Number(seedParam) >>> 0 : (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
    const s = initMatch(deckA, deckB, facA, botFaction, seed);
    setState(s);
    setReplay(createReplayRecorder(seed, deckA, deckB, facA, botFaction, botDifficulty));
    setMulliganSelection(new Set());
    setMatchStartTs(Date.now());
    setStage("mulligan");
    trackEvent("match_start", { faction: facA, botFaction, botDifficulty, savedDeck: !!savedDeckId });
  }

  function finalizeIfOver(next: MatchState, currentReplay: Replay) {
    if (next.phase === "GAME_OVER" && next.result) {
      const endTs = Date.now();
      const finished = finalizeReplay(currentReplay, next.result);
      setReplay(finished);
      setMatchEndTs(endTs);
      setStage("result");
      trackEvent("match_end", {
        winner: next.result.winner,
        reason: next.result.reason,
        rounds: next.roundNo,
        durationMs: endTs - matchStartTs,
      });
    }
  }

  function act(action: ReturnType<typeof Actions.playCard> | ReturnType<typeof Actions.passOrders> | ReturnType<typeof Actions.attack> | ReturnType<typeof Actions.passCombat> | ReturnType<typeof Actions.concede>) {
    if (!state || !replay) return;
    const result = applyAction(state, action);
    if (result.error) {
      setToast(result.error);
      return;
    }
    let rep = recordAction(replay, action);
    let next = result.state;
    setSelectedCardId(null);
    setSelectedAttacker(null);
    if (next.phase !== "GAME_OVER") {
      const botRun = runBotUntilHumanTurn(next, HUMAN, botDifficulty);
      for (const a of botRun.actions) rep = recordAction(rep, a);
      next = botRun.state;
    }
    setReplay(rep);
    setState(next);
    finalizeIfOver(next, rep);
  }

  const hashpower = useMemo(() => (state ? computeHashpower(state) : null), [state]);
  const legalHandPlays = useMemo(() => (state ? legalPlays(state, HUMAN) : []), [state]);
  const playableCardIds = useMemo(() => new Set(legalHandPlays.map((m) => m.cardId)), [legalHandPlays]);
  const legalTargets = useMemo(
    () => (state && selectedAttacker ? legalAttackTargets(state, HUMAN, selectedAttacker) : []),
    [state, selectedAttacker]
  );
  const legalTargetIids = useMemo(() => new Set(legalTargets.map((t) => t.iid)), [legalTargets]);

  function onSelectHandCard(cardId: string) {
    if (!state) return;
    if (selectedCardId === cardId) {
      setSelectedCardId(null);
      return;
    }
    const legalHere = legalHandPlays.some((m) => m.cardId === cardId);
    if (!legalHere) {
      const reason = whyIllegalPlay(state, HUMAN, cardId, 0) ?? "Nie można teraz zagrać tej karty.";
      setToast(reason);
      return;
    }
    setSelectedCardId(cardId);
  }

  function onPlayAt(node: NodeIndex) {
    if (!selectedCardId) return;
    act(Actions.playCard(HUMAN, selectedCardId, node));
  }

  function onSelectAttacker(u: Unit) {
    setSelectedAttacker((cur) => (cur?.iid === u.iid ? null : u));
  }

  function onSelectTarget(u: Unit) {
    if (!selectedAttacker) return;
    act(Actions.attack(HUMAN, selectedAttacker.iid, u.iid));
  }

  function downloadReplay() {
    if (!replay) return;
    const blob = new Blob([exportReplayJson(replay)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `node-clash-replay-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------------- SETUP ----------------
  if (stage === "setup") {
    return (
      <main className="mx-auto min-h-screen max-w-2xl px-4 py-8">
        <Link href="/" className="text-sm text-[var(--text-dim)] hover:text-white">
          ← Powrót
        </Link>
        <h1 className="mt-3 text-3xl font-extrabold">Zagraj z botem</h1>

        <h2 className="mt-6 text-lg font-bold">1. Wybierz talię</h2>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {FACTIONS.map((f) => {
            const meta = STARTER_DECK_META[f];
            const theme = factionTheme(f);
            const active = !savedDeckId && factionChoice === f;
            return (
              <button
                key={f}
                onClick={() => {
                  setFactionChoice(f);
                  setSavedDeckId(null);
                }}
                className={`rounded-lg border-2 p-3 text-left ${active ? "ring-2 ring-white" : ""}`}
                style={{ borderColor: theme.color, background: theme.bg }}
              >
                <div className="font-bold" style={{ color: theme.color }}>
                  {meta.name} · {meta.difficulty}
                </div>
                <div className="text-xs text-[var(--text-dim)]">{meta.archetype}</div>
                <div className="mt-1 text-[11px]">Mocne: {meta.strengths.join("; ")}</div>
                <div className="text-[11px]">Słabe: {meta.weaknesses.join("; ")}</div>
              </button>
            );
          })}
        </div>

        {savedDecks.length > 0 && (
          <>
            <h2 className="mt-4 text-sm font-bold text-[var(--text-dim)]">lub zapisana talia:</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              {savedDecks.map((d) => (
                <button
                  key={d.id}
                  onClick={() => setSavedDeckId(d.id)}
                  className={`rounded border px-3 py-1 text-sm ${savedDeckId === d.id ? "border-white bg-white/10" : "border-[var(--border)]"}`}
                >
                  {d.name}
                </button>
              ))}
            </div>
          </>
        )}

        <h2 className="mt-6 text-lg font-bold">2. Poziom trudności bota</h2>
        <div className="mt-2 flex gap-2">
          {BOT_DIFFICULTIES.map((d) => (
            <button
              key={d}
              onClick={() => setBotDifficulty(d)}
              className={`rounded border px-4 py-2 text-sm font-semibold ${botDifficulty === d ? "border-white bg-white/10" : "border-[var(--border)]"}`}
            >
              {BOT_LABEL[d]}
            </button>
          ))}
        </div>

        <button onClick={startMatch} className="mt-8 w-full rounded bg-white py-3 font-bold text-black">
          Rozpocznij mecz
        </button>
      </main>
    );
  }

  if (!state || !hashpower) return null;

  // ---------------- MULLIGAN ----------------
  if (stage === "mulligan") {
    const hand = state.players[HUMAN].hand;
    return (
      <main className="mx-auto min-h-screen max-w-xl px-4 py-8">
        <h1 className="text-2xl font-extrabold">Mulligan</h1>
        <p className="mt-1 text-sm text-[var(--text-dim)]">
          Zaznacz karty, które chcesz wymienić na nowe (opcjonalnie), potem potwierdź.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {hand.map((id, i) => {
            const card = CARDS_BY_ID[id];
            const marked = mulliganSelection.has(id + i);
            return (
              <button
                key={i}
                onClick={() =>
                  setMulliganSelection((prev) => {
                    const next = new Set(prev);
                    if (next.has(id + i)) next.delete(id + i);
                    else next.add(id + i);
                    return next;
                  })
                }
                className={`rounded border-2 px-3 py-2 text-sm ${marked ? "border-red-400 opacity-60 line-through" : "border-[var(--border)]"}`}
              >
                {card.name}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => {
            // map back index-tagged selection keys to plain card ids
            const ids = hand.filter((id, i) => mulliganSelection.has(id + i));
            setMulliganSelection(new Set());
            submitMulliganWithIds(ids);
          }}
          className="mt-6 w-full rounded bg-white py-3 font-bold text-black"
        >
          Potwierdź
        </button>
        {toast && <p className="mt-3 text-sm text-red-400">{toast}</p>}
      </main>
    );
  }

  function submitMulliganWithIds(ids: string[]) {
    if (!state || !replay) return;
    const action = Actions.mulligan(HUMAN, ids);
    const r1 = applyAction(state, action);
    if (r1.error) {
      setToast(r1.error);
      return;
    }
    let rep = recordAction(replay, action);
    let next = r1.state;
    const botRun = runBotUntilHumanTurn(next, HUMAN, botDifficulty);
    for (const a of botRun.actions) rep = recordAction(rep, a);
    next = botRun.state;
    setReplay(rep);
    setState(next);
    if (next.phase === "GAME_OVER") finalizeIfOver(next, rep);
    else setStage("match");
  }

  // ---------------- RESULT ----------------
  if (stage === "result" && state.result) {
    return (
      <MatchResultScreen
        state={state}
        humanPid={HUMAN}
        durationMs={matchEndTs - matchStartTs}
        onRematch={() => {
          trackEvent("rematch");
          startMatch();
        }}
        onDownloadReplay={downloadReplay}
      />
    );
  }

  // ---------------- MATCH ----------------
  const phaseLabel =
    state.phase === "ORDERS_ACTIVE" || state.phase === "ORDERS_INACTIVE"
      ? "Faza Rozkazów"
      : state.phase === "COMBAT_ACTIVE" || state.phase === "COMBAT_INACTIVE"
        ? "Faza Walki"
        : state.phase;
  const isHumanOrders =
    (state.phase === "ORDERS_ACTIVE" && state.activePlayer === HUMAN) ||
    (state.phase === "ORDERS_INACTIVE" && state.activePlayer !== HUMAN);
  const isHumanCombat =
    (state.phase === "COMBAT_ACTIVE" && state.activePlayer === HUMAN) ||
    (state.phase === "COMBAT_INACTIVE" && state.activePlayer !== HUMAN);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-3 px-3 py-4">
      <div className="flex items-center justify-between text-sm">
        <span className="font-bold">Runda {state.roundNo}/6</span>
        <span>{phaseLabel}</span>
        <button onClick={() => act(Actions.concede(HUMAN))} className="rounded border border-red-400 px-2 py-1 text-xs text-red-400">
          Poddaj
        </button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <NodeColumn
          state={state}
          node={0}
          humanPid={HUMAN}
          hashpower={hashpower}
          selectedAttacker={selectedAttacker}
          onSelectAttacker={onSelectAttacker}
          onSelectTarget={onSelectTarget}
          onPlayHere={() => onPlayAt(0)}
          playableHere={!!selectedCardId && legalHandPlays.some((m) => m.cardId === selectedCardId && m.node === 0)}
          legalTargetIids={legalTargetIids}
        />
        <NodeColumn
          state={state}
          node={1}
          humanPid={HUMAN}
          hashpower={hashpower}
          selectedAttacker={selectedAttacker}
          onSelectAttacker={onSelectAttacker}
          onSelectTarget={onSelectTarget}
          onPlayHere={() => onPlayAt(1)}
          playableHere={!!selectedCardId && legalHandPlays.some((m) => m.cardId === selectedCardId && m.node === 1)}
          legalTargetIids={legalTargetIids}
        />
        <NodeColumn
          state={state}
          node={2}
          humanPid={HUMAN}
          hashpower={hashpower}
          selectedAttacker={selectedAttacker}
          onSelectAttacker={onSelectAttacker}
          onSelectTarget={onSelectTarget}
          onPlayHere={() => onPlayAt(2)}
          playableHere={!!selectedCardId && legalHandPlays.some((m) => m.cardId === selectedCardId && m.node === 2)}
          legalTargetIids={legalTargetIids}
        />
      </div>

      {toast && <div className="rounded border border-red-400 bg-red-950/40 px-3 py-2 text-sm text-red-300">{toast}</div>}

      <HandBar
        handCardIds={state.players[HUMAN].hand}
        gas={state.players[HUMAN].gas}
        playableCardIds={playableCardIds}
        selectedCardId={selectedCardId}
        onSelect={onSelectHandCard}
      />

      <div className="flex gap-2">
        {isHumanOrders && (
          <button onClick={() => act(Actions.passOrders(HUMAN))} className="flex-1 rounded bg-white/10 py-2 text-sm font-semibold">
            Zakończ Fazę Rozkazów
          </button>
        )}
        {isHumanCombat && (
          <button onClick={() => act(Actions.passCombat(HUMAN))} className="flex-1 rounded bg-white/10 py-2 text-sm font-semibold">
            Zakończ atakowanie
          </button>
        )}
        {!isHumanOrders && !isHumanCombat && (
          <button disabled className="flex-1 rounded bg-white/5 py-2 text-sm text-[var(--text-dim)]">
            Tura przeciwnika…
          </button>
        )}
      </div>

      <EventLog events={state.events} />
    </main>
  );
}
