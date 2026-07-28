# Node Clash — X1 Card Arena MVP

Node Clash is a fast card game about controlling three Network Nodes. This repository
contains the playable browser MVP: a full TypeScript port of the reference rules engine plus
a Next.js UI (interactive tutorial, bot matches at 3 difficulty levels, card collection, deck
builder).

**This is the pre-Web3 MVP stage.** No blockchain, wallet, token, NFTs, marketplace, or paid
packs — every card is free and available immediately. See `web/README.md` for the full
technical documentation (stack, setup, tests, deployment, known limitations, roadmap).

## Repository layout

```
web/    Next.js app — the entire playable product (see web/README.md for details)
```

## What used to be here

This repository previously hosted an X1 Liquid Staking (LST) proof of concept — a
`spl-stake-pool` fork plus a "label-vault" multi-LST basket program and their frontend. That
code has been removed from the working tree and replaced with Node Clash. It is not lost: the
prior commits are still present in this repository's git history (`git log` on this branch
before the replacement commit, or check `git branch -a` — the old code may also still live on
another branch if one wasn't overwritten).

## Quick start

```bash
cd web
npm install
npm run dev
```

Open http://localhost:3000.
