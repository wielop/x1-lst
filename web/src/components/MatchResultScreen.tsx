"use client";
import { useState } from "react";
import Link from "next/link";
import type { MatchState, PlayerId } from "@/game/types";
import { trackEvent } from "@/lib/storage";

const SURVEY_QUESTIONS = [
  "Jak oceniasz mecz w skali 1-10?",
  "Czy rozumiesz, dlaczego wygrałeś lub przegrałeś?",
  "Czy wynik wydawał się sprawiedliwy?",
  "Czy zagrałbyś kolejny mecz bez nagrody?",
  "Co było niejasne albo irytujące?",
];

export function MatchResultScreen({
  state,
  humanPid,
  durationMs,
  onRematch,
  onDownloadReplay,
}: {
  state: MatchState;
  humanPid: PlayerId;
  durationMs: number;
  onRematch: () => void;
  onDownloadReplay: () => void;
}) {
  const [surveyDone, setSurveyDone] = useState(false);
  const [answers, setAnswers] = useState<string[]>(["", "", "", "", ""]);
  const [showSurvey, setShowSurvey] = useState(true);

  const result = state.result!;
  const won = result.winner === humanPid;
  const draw = result.winner === null;
  const keyEvents = state.events.filter((e) => e.type === "DEATH" || e.type === "GAME_OVER").slice(-8);

  function submitSurvey() {
    trackEvent("post_match_survey", { answers, reason: result.reason });
    setSurveyDone(true);
    setShowSurvey(false);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center gap-4 px-4 py-10 text-center">
      <h1 className={`text-4xl font-extrabold ${draw ? "text-yellow-400" : won ? "text-green-400" : "text-red-400"}`}>
        {draw ? "Remis!" : won ? "Wygrywasz!" : "Przegrywasz"}
      </h1>
      <p className="text-sm text-[var(--text-dim)]">
        Powód: {result.reason === "control_2_nodes" ? "kontrola węzłów" : result.reason === "total_hashpower_tiebreak" ? "dogrywka Hashpower" : result.reason === "concede" ? "poddanie" : "remis"}
        {" · "}
        Rund: {state.roundNo}
        {" · "}
        Czas: {Math.max(1, Math.round(durationMs / 1000))}s
      </p>

      <div className="grid w-full grid-cols-3 gap-2 text-sm">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded border border-[var(--border)] p-2">
            <div className="text-xs text-[var(--text-dim)]">Węzeł {i + 1}</div>
            <div>
              <span className="text-green-400">{result.hashpower[humanPid][i]}</span> vs{" "}
              <span className="text-red-400">{result.hashpower[(1 - humanPid) as PlayerId][i]}</span>
            </div>
            <div className="text-[10px]">{result.nodesControl[i] === humanPid ? "Ty" : result.nodesControl[i] === null ? "sporny" : "Przeciwnik"}</div>
          </div>
        ))}
      </div>

      {keyEvents.length > 0 && (
        <div className="w-full rounded border border-[var(--border)] p-2 text-left text-xs">
          <div className="mb-1 font-bold text-[var(--text-dim)]">Najważniejsze zdarzenia</div>
          {keyEvents.map((e, i) => (
            <div key={i}>{e.message}</div>
          ))}
        </div>
      )}

      {showSurvey && !surveyDone && (
        <div className="w-full rounded border border-[var(--border)] p-3 text-left text-sm">
          <div className="mb-2 font-bold">Krótka ankieta (opcjonalna)</div>
          {SURVEY_QUESTIONS.map((q, i) => (
            <div key={i} className="mb-2">
              <label className="text-xs text-[var(--text-dim)]">{q}</label>
              <input
                value={answers[i]}
                onChange={(e) => setAnswers((a) => a.map((v, j) => (j === i ? e.target.value : v)))}
                className="mt-0.5 w-full rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1 text-sm"
              />
            </div>
          ))}
          <div className="flex gap-2">
            <button onClick={submitSurvey} className="flex-1 rounded bg-white py-2 text-sm font-semibold text-black">
              Wyślij
            </button>
            <button onClick={() => setShowSurvey(false)} className="flex-1 rounded border border-[var(--border)] py-2 text-sm">
              Pomiń
            </button>
          </div>
        </div>
      )}

      <div className="mt-2 flex w-full flex-col gap-2 sm:flex-row">
        <button onClick={onRematch} className="flex-1 rounded bg-white py-3 font-bold text-black">
          Rewanż
        </button>
        <Link href="/play" className="flex-1 rounded border border-[var(--border)] py-3 text-center font-semibold">
          Wybór talii
        </Link>
      </div>
      <button onClick={onDownloadReplay} className="text-xs text-[var(--text-dim)] underline">
        Pobierz log meczu (replay JSON)
      </button>
      <Link href="/" className="text-xs text-[var(--text-dim)]">
        Strona główna
      </Link>
    </main>
  );
}

