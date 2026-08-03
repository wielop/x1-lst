# Mines

Provably-fair Mines on the X1 chain. Pick a bet and a mine count, reveal tiles
one at a time, cash out whenever you want — miss a mine and the round busts.

Behavioral design goals and full economics writeup live outside this repo;
this README covers the technical architecture only.

## What used to be here

This repository previously hosted an X1 Liquid Staking (LST) proof of
concept, then briefly a card game called Node Clash. Both are gone from the
working tree, replaced with Mines. Nothing is lost — the prior code is still
present in this repository's git history (`git log master` before this
replacement commit).

## Why the architecture looks like this

A naive "everything on-chain, mine positions stored in a plain account"
design is trivially exploitable: Solana account data is public, so any player
could read the mine layout via `getAccountInfo` before clicking a single
tile. This repo instead splits responsibilities:

- **On-chain program** (`programs/mines`) is the source of truth for funds
  and round state: it custodies the bankroll, tracks each round's bet/reveal
  progress, mints `$MINE` emission, and settles payouts. It never stores
  mine positions.
- **Resolver daemon** (`resolver/`) is an off-chain service that holds the
  secret server seed and decides `is_mine` for each tile a player requests.
  It publishes a commitment (`commit_seed`) *before* rounds play under it,
  and later reveals the raw seed (`reveal_seed`) so anyone can recompute
  every round settled under that commitment and confirm nothing was
  rewritten after the fact — the same commit-reveal trust model every
  provably-fair casino uses, just with the settlement layer on-chain instead
  of trusting a database. Tile clicks reach it over plain HTTP
  (`resolver/src/http.ts`, `POST /reveal`), not an on-chain instruction —
  only the resolver's own `resolve_reveal` call touches the chain, so a
  player never signs more than two transactions per round (`start_round`,
  `cash_out`) no matter how many tiles they click.
- **Frontend** (`web/`) is a thin client: connect wallet, start a round,
  POST tile clicks to the resolver, poll round state, cash out.

The tradeoff for dropping the on-chain "I clicked this tile" record: a
misbehaving resolver could resolve a tile nobody clicked. That can only
affect the round it happens in — payouts always go to `round.player`
regardless — so it's a mild griefing vector, not a fund-theft one. Worth
revisiting if this ever handles real money.

See the comment on `resolve_reveal` in `programs/mines/src/lib.rs` for the
precise trust boundary: the program cannot verify `is_mine` itself (that
would require storing mine positions on-chain, reintroducing the leak) —
fairness is audited after the fact via the seed commitment, not verified
live.

## Layout

```
programs/mines/    Anchor program (config, vault, round, $MINE mint)
resolver/           Off-chain seed custody + reveal resolution daemon
web/                 Next.js frontend
keys/                Testnet keypairs (gitignored)
```

## Build & deploy (testnet only)

This project is testnet-only. Do not deploy to mainnet without explicit
sign-off — see the deployer keypair note below.

```bash
anchor build
solana program deploy \
  --keypair keys/deployer-testnet.json \
  target/deploy/mines.so \
  --program-id keys/mines-program-testnet.json \
  --url https://rpc.testnet.x1.xyz
```

`keys/deployer-testnet.json` needs testnet XNT to pay for deployment —
airdrop via the testnet faucet before running the above (the public
`rpc.testnet.x1.xyz` endpoint's built-in `solana airdrop` faucet was
unavailable when this was set up; use whatever X1 testnet faucet is current).

After deploying, initialize the config account once (admin-only) and start
the resolver daemon:

```bash
cd resolver && npm install
npm start   # commits the initial seed on first run, then serves the HTTP API
```

The resolver listens on `:8787` (`RESOLVER_PORT`) by default. **The frontend
needs to reach this from the browser**, not just from this machine — running
`web` locally alongside it works via `localhost`, but a Vercel-hosted
frontend needs the resolver exposed on a real public URL with
`NEXT_PUBLIC_RESOLVER_URL` pointed at it.

The canonical running instance lives on the same VPS as the other bots in
this account (`~/mines-resolver`, PM2 process `mines-resolver`,
`51.83.160.27:8787`), started via `pm2 start npm --name mines-resolver --
start` from that directory. It's a standalone copy (not a symlink into this
repo), so `idl.ts` reads the IDL from `IDL_PATH` (set in its `.env`) instead
of assuming the monorepo's `target/idl/` layout. Redeploying a program
upgrade means re-copying `target/idl/mines.json` there and restarting the
PM2 process; changing resolver logic means re-syncing `resolver/` (minus
`node_modules`) plus `keys/resolver-testnet.json` and `seed-store.json`
(the live seed state — never regenerate it on the VPS, copy the real one).

Frontend:

```bash
cd web && npm install
cp .env.local.example .env.local
npm run dev
```

## A note on the build toolchain

Solana 1.18's bundled `cargo-build-sbf` ships an old rustc/cargo (1.75) that
can't parse manifests requiring the `edition2024` Cargo feature. Cargo's
resolver left unpinned drifts onto crates.io's latest releases of several
transitive dependencies (`blake3`, `zeroize_derive`, `indexmap`, `getrandom`
lineage crates via `cc`/`jobserver`) that have since moved to edition2024,
breaking the SBF build with `error: failed to parse manifest ... feature
'edition2024' is required`. `Cargo.lock` and the explicit version pins in
`programs/mines/Cargo.toml` work around this. If a future `cargo update`
reintroduces the problem, regenerate the lock with Solana's own bundled
cargo instead of the host one:

```bash
~/.cache/solana/v1.41/platform-tools/rust/bin/cargo generate-lockfile
```

then re-pin any crate the error names via `cargo update -p <crate> --precise <version>`.

## Economics (v1 launch parameters)

- House edge: 2% (`house_edge_bps = 200`), baked into the payout multiplier
- Payout cap: 1/3 of live bankroll per round (mirrors GigaSwap's reward-pool
  cap)
- `$MINE` emission: auto-minted by the program, proportional to wagered
  volume × mine-count risk, split 70% player / 20% seasonal leaderboard pool
  / 10% rakeback pool — only for rounds with 3+ safe reveals, to keep it
  unfarmable by instant-cashout bots
- Emission rate decays in steps as cumulative volume crosses thresholds (see
  `VOLUME_THRESHOLDS` in `programs/mines/src/lib.rs`) — these are launch
  placeholders, tune against real volume before mainnet
