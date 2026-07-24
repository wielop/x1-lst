# X1 Liquid Staking

A liquid staking token (LST) for the [X1](https://x1.xyz) network, built from
Solana Labs' audited `spl-stake-pool` program (v1.0.0, `solana-program 1.17.6`
generation — the version whose toolchain requirements match X1's current
runtime). Stake XNT, receive a pool token that represents your share of stake
delegated across multiple X1 validators, and redeem it later for XNT plus
accrued rewards.

**Status: testnet only.** Nothing here has been deployed to X1 mainnet, and it
should not be until testnet validation is complete and reviewed.

## Why a fork instead of a new program

The stake pool program is a well-audited, generic "factory" — anyone can spin
up their own pool + mint under a compatible deployment of it, the same way
[Sanctum](https://sanctum.so) does on Solana. X1 didn't have a public,
independent one when this was built (the only existing LST on X1 is
[Ripper Pool](https://x1ripper.xyz), program `XPoo1Fx6KNgeAzFcq2dPTo95bWGUSj5KdPVqYj9CZux`).
Rather than modify the audited program logic, this repo deploys the unmodified
program under its own program ID.

## Layout

```
stake-pool/program/   the on-chain program (source unmodified except declare_id!)
stake-pool/cli/        spl-stake-pool-cli, used to create/manage the pool
stake-pool/js/         reference JS client at the matching version (see web/lib/stake-pool)
libraries/, token/,     path-dependency crates the program/CLI need to build —
token-metadata/,        vendored from solana-program-library at the same tag
token-group/, memo/,    (stake-pool-v1.0.0) rather than pulled from crates.io,
associated-token-account/  to keep the dependency graph pinned and buildable
                        with X1's current toolchain
web/                    Next.js frontend (stake/unstake UI + pool stats)
label-vault/program/   custom program: multi-LST basket vault ("Labels"),
                        see below
```

## Why this specific version

X1's `cargo build-sbf` toolchain (platform-tools v1.41, rustc 1.75) can't
build the current upstream `solana-program/stake-pool` — it depends on
crates that require rustc ≥1.79 and a newer Cargo.lock format. `stake-pool-v1.0.0`
(`solana-program = "1.17.6"`) is the newest tag that still builds cleanly with
that toolchain — the same generation already used successfully for other X1
programs in this project.

## Building the program

```bash
cd stake-pool/program
cargo build-sbf   # requires solana-cli with the matching platform-tools; see below
```

If you hit `lock file version 4 requires -Znext-lockfile-bump`, your ambient
cargo bumped the checked-in v3 lockfile — restore it from git and pin
`rust-toolchain.toml` in the program dir to `1.75.0` (or whatever version your
`cargo build-sbf` bundles) before invoking any cargo command in that
directory, including `cargo metadata`.

Building `stake-pool/cli` requires `libudev` headers (Ledger/HID support) at
compile time. If you can't `apt install libudev-dev`, download it without root:

```bash
apt-get download libudev-dev
dpkg-deb -x libudev-dev_*.deb /tmp/libudev-shim
CFLAGS="-I/tmp/libudev-shim/usr/include" \
PKG_CONFIG_PATH=/tmp/libudev-shim/usr/lib/x86_64-linux-gnu/pkgconfig \
cargo build --release
```

**Before building, set `declare_id!` in `stake-pool/program/src/lib.rs`** to
the pubkey of the keypair you're actually deploying with — the CLI derives
every PDA (withdraw authority, stake accounts, ...) from that constant, not
from the address you pass to `solana program deploy`. A mismatch here makes
every instruction fail with account/owner errors that look unrelated to the
real cause.

## Testnet deployment

| Item | Address |
|---|---|
| Program | `HjJ81j6LvguqZP17WwPrWihqpCqWYMqPdVCEDtDXDd23` |
| Pool | `9Ct35Dtu7Pnk2LXsKSeLyGupnvZpfxVDvvQ8X8biz6Ne` |
| Pool mint (LST) | `6xsd6uzHZpWnaHWyWvEatF8qKPDaJ2MoH9FY1M3pyAcB` |
| Reserve stake | `GgHkhne79PNdNFkMpWbh1odXq77adZUAM5HxwLVRwehd` |
| Validator list | `BR2qMBYV399e27F872Pc2UzwGhRoj9X3GjgQC2GMu9YE` |

Fees: 5% epoch fee, 0.2% stake/SOL withdrawal fee, 0% deposit fee (mirrors
Ripper Pool's published fee schedule). 4 validators added, selected by the
methodology below (the top 4 of testnet's ~10 vote accounts pass every
filter — the rest are either delinquent test nodes or negligible stake).

Validated end-to-end on testnet: pool creation, `deposit-sol` → LST mint,
`withdraw-sol` → LST burn, `add-validator`, `increase-validator-stake`
(delegation confirmed active), and `update` across an epoch boundary.

## Validator selection methodology

`web/lib/validatorSelection.ts`, surfaced at `/api/validators` and on the
`/dashboard` page. Approximates Ripper Pool's self-stake-percentile filter
(which requires mining individual stake accounts per validator) using two
cheap RPC calls — `getVoteAccounts` and `getClusterNodes` — instead:

- drop delinquent validators
- drop commission > 10%
- drop activated stake < 1000 XNT (same floor Ripper uses)
- drop validators whose latest-epoch vote credits are < 0.5x the field
  median (a skip-rate proxy that doesn't require leader-schedule reconciliation)
- drop validators not running one of the network's most common software versions

Survivors are ranked by activated stake and capped at a configurable limit.
This is a **read-only report** — actually adding a validator to the pool
still requires the staker keypair and is done out-of-band via the CLI, never
exposed through the deployed site.

**Known issue, not ours to fix:** X1 testnet's public RPC
(`rpc.testnet.x1.xyz`) is a proxy in front of multiple backend nodes with
inconsistent health — some delinquent, some stuck on a stale slot. Reads
intermittently return `AccountNotFound` or HTTP 503 even for accounts that
definitely exist. The frontend retries reads a few times before giving up;
CLI operations may need a manual retry.

## label-vault: basket vault ("Labels")

A second, custom program modeled on [ClearSol](https://clearsol.network) —
rather than a single-pool LST, a "Label" is a user-created basket that splits
a deposit across several underlying stake-pool-family LSTs (by weight) and
mints one share token representing the blended position. NAV is the sum of
each holding's value at that pool's own exchange rate
(`total_lamports / pool_token_supply`); no separate "boost" is fabricated —
ClearSol's own docs don't explain where their extra ~4.4% over base APY
actually comes from, so we only display real, attributable yield.

- **Program:** `HuxK4tFifoCfUzN1asHf5xae7XqszmkEC9gMvxPSVekG` (testnet)
- Underlying allocations are read live from each pool's on-chain `StakePool`
  account (reserve, mint, fee account, withdraw authority) — never trusted
  from client input — so a Label can point at *any* stake-pool-family program,
  including Ripper Pool or the official X1 Delegation Program once this goes
  to mainnet. On testnet it points at our own two pool instances
  (`9Ct35Dtu7Pnk2LXsKSeLyGupnvZpfxVDvvQ8X8biz6Ne` and
  `9SA2Xsqn5BbihiswScziKaGWmjr6KAByqb1emEsnC1fW`) since neither Ripper nor the
  Delegation Program exist there — CPI can't cross clusters, so this is the
  only way to test the mechanism before mainnet.
- `MAX_ALLOCATIONS` is currently capped at **2** (see the note in
  `label-vault/program/src/state.rs`) — SBF's 4KB-per-stack-frame limit is
  tight, and raising this needs either a hand-rolled (non-derive) borsh
  deserializer for `VaultConfig` or confirming `--arch sbfv2` is safe for the
  target cluster.
- Validated end-to-end on testnet: `CreateLabel` (60/40 split), `Deposit` (fans
  out via CPI into both underlying pools' `DepositSol`, mints shares at
  pre-deposit NAV), `Withdraw` (burns shares, CPIs `WithdrawSol` proportionally
  out of each pool straight to the withdrawer).

**Two SBF stack-frame gotchas hit while building this**, worth knowing before
extending it:
1. Any per-instruction handler large enough to get inlined into the shared
   dispatcher can blow the 4KB/frame limit *without necessarily generating a
   compiler warning* — the compiler catches some cases (a giant borsh-derived
   `AbiEnumVisitor` in `solana_program` itself trips this on every build, log
   noise but harmless) but not others. Mark every non-trivial per-instruction
   function `#[inline(never)]`, and extract per-loop-iteration bodies into
   their own `#[inline(never)]` functions too — a loop body inlined into its
   caller accumulates stack across iterations in ways that are hard to predict.
2. Borsh's derived, *checked* `try_from_slice` (which verifies every byte gets
   consumed) measurably increases stack usage over
   `solana_program::borsh0_10::try_from_slice_unchecked` for the same struct —
   large account reads should use the unchecked variant regardless of whether
   there's a real size mismatch to guard against.

## Frontend

```bash
cd web
npm install
npm run dev
```

`lib/poolConfig.ts` selects network config via `NEXT_PUBLIC_X1_NETWORK`
(defaults to `testnet`; `mainnet` is intentionally unset until the pool is
live there). `lib/stake-pool/` is the JS client vendored from the matching
`stake-pool-v1.0.0` tag rather than an npm install, since later versions of
`@solana/spl-stake-pool` target a different on-chain account layout.

## Not done yet

- Mainnet deployment (deliberately withheld pending further testnet review)
- Running the validator selection methodology against the (much larger)
  mainnet validator set before going live
- Security review of the deployment/ops process (the program itself is the
  unmodified, previously-audited Solana Labs code)
- label-vault: frontend (Create Label wizard + per-label deposit/withdraw UI),
  raising `MAX_ALLOCATIONS` past 2, and (for mainnet) pointing allocations at
  the real Ripper Pool / X1 Delegation Program addresses
