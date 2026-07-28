# Node Clash — MVP web client

A browser-playable MVP of **Node Clash** (working title, part of the "X1 Card Arena" design
project). Fast card game about controlling three Network Nodes; matches run entirely
client-side against a bot, no server, no blockchain, no login required.

## What's in this MVP (and what isn't)

**In scope:** the full rules engine, all 60 cards, 4 starter decks, an interactive tutorial,
matches against a bot (3 difficulty levels), a card collection browser, a deck builder with
`localStorage` persistence, lightweight `localStorage`-based telemetry, and match replay
export.

**Explicitly out of scope for this stage** (per the project brief): blockchain, wallet
integration, tokens, NFTs, marketplace, paid card packs, and paid-prize tournaments. All 60
cards are free and available from the start. PvP (real-time multiplayer) is also **not
implemented** — see "Known limitations" below.

## Rules summary

- The board has **3 Network Nodes**. A match is exactly **6 rounds**.
- Each round: both players get Gas (grows with the round number), draw a card, then take
  turns playing cards (Orders Phase) and attacking (Combat Phase). Who acts first alternates
  by round parity, so the advantage evens out over a full match.
- Playing a unit costs its printed cost **plus a Congestion Fee** (+1 Gas per your own unit
  already at that node) — spreading your board out is usually cheaper than stacking it.
- At the end of round 6, each node's **Hashpower** (sum of your alive units' ATK there) is
  compared. Whoever controls **2 of 3 nodes** wins; a 1-1-contested split falls back to total
  Hashpower; an exact tie is a draw.
- Full rules: `/home/wielop/x1-card-arena/docs/02-rules.md` (design repo — not included here,
  referenced for context; this app's `src/game/*.ts` is the authoritative implementation).

## Stack

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS v4 · ESLint 9
(`eslint-config-next`) · Vitest (engine/unit tests) · Playwright (browser tests).

## Directory layout

```
src/game/            Pure TypeScript game engine — framework-agnostic, importable without React
  types.ts             All core type definitions (Card, Unit, MatchState, Action, ...)
  constants.ts          Balance-relevant numeric constants (final v3 balance values)
  cards.ts              GENERATED — 60 cards, from the Python reference simulator's output
  decks.ts               Starter deck definitions + deck validation rules
  engine.ts              Core reducer: initMatch, applyAction, resolveMatch, phase machine
  engine-rng.ts           Seeded PRNG (mulberry32) + deck shuffle/draw primitives
  effects.ts              Card effect resolution (on_play/on_death/passive ops) + aura math
  validation.ts            Legal-move computation + human-readable illegal-move reasons
  actions.ts                Action-creator helpers
  bot.ts                     3-difficulty bot AI (Easy/Normal/Hard), drives itself via applyAction
  replay.ts                   Replay recording, JSON export/import, deterministic replay-back
  __tests__/                   Vitest suite (engine mechanics, card data validation, parity)
src/components/       React UI components (CardView, NodeColumn, HandBar, EventLog, ...)
src/app/              Next.js App Router pages: /, /tutorial, /play, /collection, /deck-builder, /rules
src/lib/              localStorage persistence (decks, telemetry) + faction color theme
scripts/generate-cards.ts   Regenerates src/game/cards.ts from the Python reference data
e2e/                  Playwright browser tests
```

## Card data

`src/game/cards.ts` is a **generated file** — the single source of truth is the Python
reference simulator's fully-balanced (v3) export
(`sim/results/FINAL_BALANCED_CARDS_v3.json` in the design repo, which has all 3 balance-patch
iterations applied on top of the v0 baseline). To regenerate after that file changes:

```bash
npx tsx scripts/generate-cards.ts
```

Do not hand-edit `src/game/cards.ts` — edit the Python source data and regenerate instead, or
the two will drift apart.

## Match replays / bug reports

Every match records its seed, both decks/factions, the full ordered action list, and the
final result. From the result screen, "Pobierz log meczu" downloads this as JSON. That file is
enough to deterministically reconstruct the exact match (`replayMatch()` in `src/game/replay.ts`)
— attach it to a bug report and the exact sequence that produced it can be replayed back.

## Install / run / test

```bash
npm install
npm run dev          # http://localhost:3000
npm run build         # production build
npm run start          # serve the production build

npm run typecheck       # tsc --noEmit
npm run lint              # eslint .
npm run test                # vitest (engine + card-data unit tests)
npm run e2e                   # playwright (browser tests — see note below)
```

**Playwright note:** in a minimal/headless Linux environment without root, Chromium's browser
binary may be missing a few shared libraries (`libnspr4`, `libnss3`, `libasound2`) that
`playwright install-deps` normally installs via `apt`. If you don't have root, you can fetch
just those `.deb`s without installing them system-wide and point `LD_LIBRARY_PATH` at the
extracted files:

```bash
mkdir -p /tmp/pwlibs && cd /tmp/pwlibs
apt-get download libnspr4 libnss3 libasound2t64
for f in *.deb; do dpkg-deb -x "$f" extracted/; done
export LD_LIBRARY_PATH=/tmp/pwlibs/extracted/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH
npx playwright test
```

## Deployment (Vercel)

This app lives in the `web/` subdirectory of the repository — the Vercel project's **Root
Directory** setting must be `web` (there is no `vercel.json`; it's a dashboard setting). No
environment variables are required for this MVP (no external services are wired up yet).
Pushing to the branch Vercel watches triggers an automatic build and deploy.

## Known limitations

- **Balance:** after 3 iterations of AI-simulated balance testing (16,000+ matches, see the
  design repo), Miners/Degens/Validators land close to the 47-53% win-rate target; **Builders
  remains under target (~40%)**, specifically weak against Validators. This is a known,
  documented gap — not something this MVP pass attempted to fix further.
- **No PvP.** Only bot matches are implemented. Real-time multiplayer (room codes, server-
  authoritative validation, reconnect handling) would need real backend infrastructure and was
  explicitly deferred per the project brief ("finish a stable bot game first").
- **No backend / no accounts.** Decks and telemetry are `localStorage`-only; nothing syncs
  across devices.
- **Telemetry is local-only.** Events are recorded to `localStorage` and exportable as JSON;
  there's no Supabase (or similar) project wired up in this repo yet, so nothing is sent
  anywhere automatically. The event shape is intentionally simple so a real backend can be
  swapped in later without changing call sites (`src/lib/storage.ts::trackEvent`).
- **Bot AI is heuristic, not adaptive.** The "Hard" bot does a real 1-ply lookahead (via
  literally re-running `applyAction` on candidate moves and comparing resulting Hashpower), but
  none of the three difficulties learn from the player.
- **Cross-language parity** with the Python reference engine is verified via 10 targeted, fixed
  fixture scenarios (`src/game/__tests__/parity.test.ts`) whose expected values were computed
  by actually running `sim/parity_check.py` against the reference engine — not via RNG-stream
  matching (the two engines use independent seeded RNGs by design; see the comment at the top
  of `engine-rng.ts`).

## Planned later (not in this MVP)

Real-time PvP, a backend/accounts system, wallet connection, NFT collectible variants,
marketplace, paid card packs with a pity system, crafting, battle pass, ranked ladder with a
real matchmaking service, sponsored/B2B card campaigns. All of these are designed (not just
imagined) in the companion design documents in the `x1-card-arena` project — this MVP
deliberately builds only the off-chain gameplay core first, per the project's own stated
priority order.
