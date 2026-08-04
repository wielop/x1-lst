use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash as sha256;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("5ViMkjJFgjUD9tuouTpjZ3m86jyGH8iB6h3r4Dxa4BCe");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// v1 ships a single fixed 5x5 grid. Configurable grid sizes are a v2 concern.
pub const TOTAL_TILES: u8 = 25;
pub const MAX_MINES: u8 = 24;
pub const MIN_MINES: u8 = 1;

/// Below this many safe reveals, a cash-out earns no $MINE emission at all.
/// Stops bots from farming emission by insta-cashing-out on the first tile.
pub const MIN_REVEALS_FOR_EMISSION: u8 = 3;

/// Fixed-point scale used for multiplier math (1_000_000 == 1.0000x).
pub const MULT_SCALE: u128 = 1_000_000;

/// Fixed-point scale used for the emission-rate curve.
pub const EMISSION_SCALE: u128 = 1_000_000;

/// A single payout can never drain more than 1/3 of the bankroll in one round
/// (same cap convention as GigaSwap's reward pool).
pub const PAYOUT_CAP_DIVISOR: u64 = 3;

/// 1 XNT == 1_000_000_000 lamports, same decimals convention as native SOL.
pub const LAMPORTS_PER_XNT: u64 = 1_000_000_000;

/// Emission-rate halving schedule, keyed by *cumulative wagered volume*
/// (not by wall-clock time) so early/active players are rewarded more and
/// supply growth decays as the game matures.
///
/// NOTE: the concrete thresholds/rates below are launch placeholders — tune
/// them against real volume data before mainnet, this is business calibration
/// not a code defect.
pub const VOLUME_THRESHOLDS: [(u64, u128); 5] = [
    (1_000_000 * LAMPORTS_PER_XNT, 1_000_000),
    (5_000_000 * LAMPORTS_PER_XNT, 500_000),
    (20_000_000 * LAMPORTS_PER_XNT, 250_000),
    (80_000_000 * LAMPORTS_PER_XNT, 125_000),
    (u64::MAX, 62_500),
];

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const MINT_SEED: &[u8] = b"mine_mint";
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";
pub const ROUND_SEED: &[u8] = b"round";

// --- Wykop (time-based mining) ---
pub const DIG_CONFIG_SEED: &[u8] = b"dig_config";
pub const DIG_SESSION_SEED: &[u8] = b"dig_session";

/// Exactly 3 duration tiers (30s/60s/90s at launch) — fixed, not extensible,
/// unlike rarity tiers. Nothing in the design calls for more than a handful
/// of duration options, so a fixed-size array keeps DigConfig simple.
pub const DIG_TIER_COUNT: usize = 3;

/// Reserved capacity for rarity tiers, most of it unused at launch (only 2
/// are populated: Rare, Epic — "Common" is the deterministic floor and
/// isn't part of this table at all). Sized generously up front so adding a
/// 3rd/4th/5th tier later is an admin instruction (`update_rarity_tiers`),
/// not a redeploy or account migration.
pub const MAX_RARITY_TIERS: usize = 8;

/// Sentinel meaning "no bonus tier hit this dig" — floor-only payout.
pub const RARITY_NONE: u8 = 0xFF;

/// Fixed-point scale for the staking reward accumulator (Phase B).
pub const ACC_REWARD_SCALE: u128 = 1_000_000_000_000;

// --- $MINE staking (Phase B) ---
// v3: replaces the single shared-slot-per-owner StakePosition with a
// multi-position model (Position, seeded by owner + a global counter) so
// a player can hold any number of concurrent locks AND timed burns, each
// tracked and accrued independently — no more "unstake before you can
// lock again". Burn also stopped being permanent: it's now a time-limited
// weight boost like a lock, but with an INVERSE duration/multiplier curve
// (short duration = high multiplier, long = low) instead of a flat
// forever-multiplier. Two real problems this fixes:
//   1. A permanent weight boost meant early burners captured an
//      ever-growing share of every future reward-pool skim forever,
//      crowding out later stakers more and more as the pool matured.
//   2. Without the inversion, burn would always beat lock at max
//      duration + max multiplier with zero trade-off, since burn's token
//      cost is already paid up front regardless of chosen duration —
//      unlike a lock, where duration has a real, symmetric cost
//      (illiquidity) that offsets the bigger multiplier.
// Expiry (weight leaving the pool once unlock_at passes) is reaped via
// `expire_position`, callable by ANYONE — not just the position's owner —
// so a keeper/cron process can sweep expired positions even if the owner
// never comes back to do it themselves. Fresh seeds throughout since the
// whole account layout changed; testnet state under the old seeds is
// simply abandoned (no migration — nothing there was ever meant to be
// permanent).
pub const STAKING_POOL_SEED: &[u8] = b"staking_pool_v3";
pub const POSITION_SEED: &[u8] = b"position_v1";
pub const STAKE_TOKEN_VAULT_SEED: &[u8] = b"stake_token_vault_v3";
pub const STAKING_AUTHORITY_SEED: &[u8] = b"staking_authority_v3";
pub const REWARD_VAULT_SEED: &[u8] = b"reward_vault_v3";

pub const MAX_LOCK_TIERS: usize = 6;
pub const MAX_BURN_TIERS: usize = 6;

// --- $MINE/XNT liquidity pool (Phase C) ---
pub const LIQUIDITY_POOL_SEED: &[u8] = b"liquidity_pool";
pub const POOL_AUTHORITY_SEED: &[u8] = b"pool_authority";
pub const POOL_XNT_VAULT_SEED: &[u8] = b"pool_xnt_vault";
pub const POOL_MINE_VAULT_SEED: &[u8] = b"pool_mine_vault";

/// Swap fee, kept in the pool's own reserves (there's only one LP —
/// admin/treasury — for v1, so this just grows that position; no separate
/// LP-share accounting yet, deliberately out of scope until this needs to
/// support multiple liquidity providers).
pub const SWAP_FEE_BPS: u64 = 30;

/// $MINE has 6 decimals (see initialize_mint); used to convert between a
/// lamport-denominated XNT value and a raw $MINE token amount when pricing
/// off the pool's reserves.
pub const MINE_DECIMALS_SCALE: u128 = 1_000_000;

/// What fraction of a dig's paid-in XNT value the floor should keep
/// targeting once a real market price is available — this is the number
/// that makes the floor price-aware instead of purely volume-schedule-blind
/// (see resolve_dig). 70% mirrors the same order of magnitude as Mines'
/// house edge leaving room for the rest to be genuine house margin.
pub const FLOOR_TARGET_BPS: u128 = 7_000;

/// Wykop's incoming XNT is unlike Mines' — resolve_dig never draws XNT
/// back out of the shared vault (it only ever mints $MINE), so unlike
/// Mines' wager, 100% of a dig's payment is unencumbered revenue with no
/// payout obligation behind it. Confirmed split with the user
/// (2026-08-04): staking gets the biggest share (it needs to be a
/// genuinely attractive reason to hold $MINE), buyback+burn and the
/// liquidity pool split the rest evenly (both are direct, automatic
/// counterweights to the fact that Wykop is constantly minting new
/// supply), and only a small remainder still supports Mines' shared
/// bankroll — a "thanks for existing in the same ecosystem" contribution,
/// not a subsidy Wykop owes Mines. See route_wykop_wager.
pub const WYKOP_STAKING_BPS: u64 = 4_000; // 40%
pub const WYKOP_BUYBACK_BPS: u64 = 2_500; // 25%
pub const WYKOP_LIQUIDITY_BPS: u64 = 2_500; // 25%
// Remainder (10%) goes to the shared vault — not a named constant since
// it's whatever's left after the other three, avoiding any rounding dust
// getting silently dropped.

#[program]
pub mod mines {
    use super::*;

    /// Step 1/3 of admin setup: creates Config and the native-lamport vault.
    /// Split into three instructions (see `initialize_mint`,
    /// `initialize_pools`) purely to stay under the BPF 4KB stack frame —
    /// validating every account (config + mint + two token accounts) in one
    /// instruction overflows the stack at runtime even though each
    /// individual function's static frame looks fine in isolation.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        resolver_authority: Pubkey,
        treasury_authority: Pubkey,
        house_edge_bps: u16,
        min_bet: u64,
        max_bet: u64,
    ) -> Result<()> {
        require!(house_edge_bps < 10_000, MinesError::InvalidParam);
        require!(min_bet > 0 && min_bet <= max_bet, MinesError::InvalidParam);

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.resolver_authority = resolver_authority;
        config.treasury_authority = treasury_authority;
        config.mine_mint = Pubkey::default();
        config.leaderboard_pool = Pubkey::default();
        config.rakeback_pool = Pubkey::default();
        config.house_edge_bps = house_edge_bps;
        config.min_bet = min_bet;
        config.max_bet = max_bet;
        config.cumulative_volume = 0;
        config.total_rounds = 0;
        config.current_seed_hash = [0u8; 32];
        config.seed_nonce = 0;
        config.paused = false;
        config.bump = ctx.bumps["config"];
        config.vault_bump = ctx.bumps["vault"];
        config.mint_authority_bump = 0;
        ctx.accounts.vault.bump = ctx.bumps["vault"];

        emit!(ConfigInitialized {
            admin: config.admin,
            resolver_authority: config.resolver_authority,
            treasury_authority: config.treasury_authority,
            mine_mint: config.mine_mint,
            house_edge_bps,
            min_bet,
            max_bet,
        });
        Ok(())
    }

    /// Step 2/3 of admin setup: creates the $MINE mint (PDA-owned authority).
    pub fn initialize_mint(ctx: Context<InitializeMint>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.mine_mint = ctx.accounts.mine_mint.key();
        config.mint_authority_bump = ctx.bumps["mint_authority"];
        Ok(())
    }

    /// Step 3/3 of admin setup: creates the leaderboard and rakeback $MINE
    /// token accounts that cash_out mints emission into.
    pub fn initialize_pools(ctx: Context<InitializePools>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.leaderboard_pool = ctx.accounts.leaderboard_pool.key();
        config.rakeback_pool = ctx.accounts.rakeback_pool.key();
        Ok(())
    }

    /// Resolver publishes hash(server_seed) *before* any round that will use
    /// it is allowed to start. Rounds record which commitment they were
    /// opened under; the raw seed is revealed later via `reveal_seed` so
    /// anyone can recompute every round settled under that commitment and
    /// confirm the resolver never rewrote history.
    pub fn commit_seed(ctx: Context<CommitSeed>, seed_hash: [u8; 32]) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let previous_hash = config.current_seed_hash;
        config.current_seed_hash = seed_hash;
        config.seed_nonce = config.seed_nonce.checked_add(1).ok_or(MinesError::MathOverflow)?;

        emit!(SeedCommitted {
            seed_hash,
            previous_hash,
            nonce: config.seed_nonce,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    /// Publishes the raw seed behind a retired commitment for public audit.
    pub fn reveal_seed(ctx: Context<RevealSeed>, raw_seed: [u8; 32], committed_hash: [u8; 32]) -> Result<()> {
        let computed = sha256(&raw_seed).to_bytes();
        require!(computed == committed_hash, MinesError::SeedMismatch);

        emit!(SeedRevealed {
            committed_hash,
            raw_seed,
            slot: Clock::get()?.slot,
        });
        let _ = ctx.accounts.resolver_authority;
        Ok(())
    }

    pub fn start_round(
        ctx: Context<StartRound>,
        bet_amount: u64,
        mine_count: u8,
        client_seed: [u8; 32],
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(!config.paused, MinesError::Paused);
        require!(mine_count >= MIN_MINES && mine_count <= MAX_MINES, MinesError::InvalidMineCount);
        require!(bet_amount >= config.min_bet && bet_amount <= config.max_bet, MinesError::BetOutOfRange);
        require!(config.current_seed_hash != [0u8; 32], MinesError::NoSeedCommitted);

        // Skim a small % of the wager straight to staking rewards before
        // any of it reaches the main vault — see route_wager_skim. This is
        // what makes the staking reward pool grow automatically from real
        // play instead of needing a manual admin top-up.
        let skim = route_wager_skim(
            bet_amount,
            &ctx.accounts.player.to_account_info(),
            &ctx.accounts.reward_vault.to_account_info(),
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &mut ctx.accounts.staking_pool,
        )?;
        let to_vault = bet_amount.checked_sub(skim).ok_or(MinesError::MathOverflow)?;

        // Move the rest of the bet from player -> vault (native lamports).
        invoke(
            &system_instruction::transfer(&ctx.accounts.player.key(), &ctx.accounts.vault.key(), to_vault),
            &[
                ctx.accounts.player.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let round_id = config.total_rounds;
        config.total_rounds = config.total_rounds.checked_add(1).ok_or(MinesError::MathOverflow)?;
        config.cumulative_volume = config.cumulative_volume.saturating_add(bet_amount);

        let round = &mut ctx.accounts.round;
        round.player = ctx.accounts.player.key();
        round.round_id = round_id;
        round.bet_amount = bet_amount;
        round.mine_count = mine_count;
        round.client_seed = client_seed;
        round.seed_commitment = config.current_seed_hash;
        round.requested_bitmap = 0;
        round.revealed_bitmap = 0;
        round.revealed_count = 0;
        round.status = RoundStatus::Active as u8;
        round.bump = ctx.bumps["round"];

        emit!(RoundStarted {
            round: round.key(),
            player: round.player,
            round_id,
            bet_amount,
            mine_count,
            seed_commitment: round.seed_commitment,
        });
        Ok(())
    }

    /// Resolver-signed settlement of a tile the player clicked. The click
    /// itself is a plain HTTP call to the resolver (see resolver/src/http.ts)
    /// — no player-signed transaction, so clicking through a round costs
    /// zero extra wallet approvals beyond start_round/cash_out. The resolver
    /// derives `is_mine` off-chain from its secret server seed; this program
    /// does not (and structurally cannot, without leaking mine positions
    /// through readable account data) verify the mine layout itself.
    /// Fairness is enforced after the fact via `commit_seed` / `reveal_seed`,
    /// not verified live on-chain — same trust model used by every
    /// provably-fair off-chain-resolved casino game. The tradeoff for
    /// dropping the on-chain request step: a malicious resolver could in
    /// principle resolve a tile the player never clicked, but that can only
    /// hurt the round it happens in (payouts always go to round.player
    /// regardless), so it's a mild griefing vector, not a fund-theft one.
    pub fn resolve_reveal(ctx: Context<ResolveReveal>, tile_index: u8, is_mine: bool) -> Result<()> {
        let round = &mut ctx.accounts.round;
        require!(round.status == RoundStatus::Active as u8, MinesError::RoundNotActive);
        require!(tile_index < TOTAL_TILES, MinesError::InvalidTileIndex);
        let bit = 1u32 << tile_index;
        require!(round.revealed_bitmap & bit == 0, MinesError::TileAlreadyHandled);
        round.revealed_bitmap |= bit;

        if is_mine {
            round.status = RoundStatus::Busted as u8;
            emit!(RoundBusted {
                round: round.key(),
                round_id: round.round_id,
                player: round.player,
                tile_index,
                revealed_count: round.revealed_count,
            });
        } else {
            round.revealed_count = round.revealed_count.checked_add(1).ok_or(MinesError::MathOverflow)?;
            let multiplier_scaled = fair_multiplier_scaled(round.revealed_count, round.mine_count, TOTAL_TILES)?;
            emit!(RevealResolved {
                round: round.key(),
                round_id: round.round_id,
                player: round.player,
                tile_index,
                revealed_count: round.revealed_count,
                multiplier_scaled,
            });
        }
        Ok(())
    }

    pub fn cash_out(ctx: Context<CashOut>) -> Result<()> {
        let round = &mut ctx.accounts.round;
        require!(round.status == RoundStatus::Active as u8, MinesError::RoundNotActive);
        require!(round.revealed_count > 0, MinesError::NothingToCashOut);

        let config = &ctx.accounts.config;
        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();

        let fair_m = fair_multiplier_scaled(round.revealed_count, round.mine_count, TOTAL_TILES)?;
        let house_m = fair_m
            .checked_mul((10_000u128).checked_sub(config.house_edge_bps as u128).ok_or(MinesError::MathOverflow)?)
            .ok_or(MinesError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(MinesError::MathOverflow)?;
        let raw_payout = (round.bet_amount as u128)
            .checked_mul(house_m)
            .ok_or(MinesError::MathOverflow)?
            .checked_div(MULT_SCALE)
            .ok_or(MinesError::MathOverflow)?;
        let cap = (vault_lamports as u128) / PAYOUT_CAP_DIVISOR as u128;
        let payout: u64 = raw_payout.min(cap).try_into().map_err(|_| MinesError::MathOverflow)?;

        // Vault PDA pays the player directly (lamport-level transfer, PDA is
        // system-owned so it can be debited without invoke_signed).
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= payout;
        **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += payout;

        let mut player_mint = 0u64;
        let mut leaderboard_mint = 0u64;
        let mut rakeback_mint = 0u64;

        if round.revealed_count >= MIN_REVEALS_FOR_EMISSION {
            let risk_bps = (round.mine_count as u128) * 10_000u128 / (TOTAL_TILES as u128);
            let effective_wager = (round.bet_amount as u128)
                .checked_mul(risk_bps)
                .ok_or(MinesError::MathOverflow)?
                .checked_div(10_000)
                .ok_or(MinesError::MathOverflow)?;
            let rate = emission_rate_scaled(config.cumulative_volume);
            let total_emission: u128 = effective_wager
                .checked_mul(rate)
                .ok_or(MinesError::MathOverflow)?
                .checked_div(EMISSION_SCALE)
                .ok_or(MinesError::MathOverflow)?;

            // rakeback_pool is retired (was a stub with no defined
            // redemption mechanism since launch — see StakingPool below,
            // which is what it always should have plugged into). Its old
            // 10% share is folded into leaderboard_pool. The account is
            // still passed through CashOut's context for layout/instruction
            // compatibility with what's already live, it just never
            // receives a mint anymore.
            player_mint = (total_emission * 70 / 100) as u64;
            leaderboard_mint = (total_emission - (total_emission * 70 / 100)) as u64;
            rakeback_mint = 0u64;

            let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &[config.mint_authority_bump]];
            let signer = &[seeds];

            if player_mint > 0 {
                token::mint_to(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        MintTo {
                            mint: ctx.accounts.mine_mint.to_account_info(),
                            to: ctx.accounts.player_mine_ata.to_account_info(),
                            authority: ctx.accounts.mint_authority.to_account_info(),
                        },
                        signer,
                    ),
                    player_mint,
                )?;
            }
            if leaderboard_mint > 0 {
                token::mint_to(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        MintTo {
                            mint: ctx.accounts.mine_mint.to_account_info(),
                            to: ctx.accounts.leaderboard_pool.to_account_info(),
                            authority: ctx.accounts.mint_authority.to_account_info(),
                        },
                        signer,
                    ),
                    leaderboard_mint,
                )?;
            }
            if rakeback_mint > 0 {
                token::mint_to(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        MintTo {
                            mint: ctx.accounts.mine_mint.to_account_info(),
                            to: ctx.accounts.rakeback_pool.to_account_info(),
                            authority: ctx.accounts.mint_authority.to_account_info(),
                        },
                        signer,
                    ),
                    rakeback_mint,
                )?;
            }
        }

        round.status = RoundStatus::CashedOut as u8;

        emit!(CashedOut {
            round: round.key(),
            round_id: round.round_id,
            player: round.player,
            revealed_count: round.revealed_count,
            payout,
            mine_minted_player: player_mint,
            mine_minted_leaderboard: leaderboard_mint,
            mine_minted_rakeback: rakeback_mint,
        });
        Ok(())
    }

    pub fn deposit_bankroll(ctx: Context<DepositBankroll>, amount: u64) -> Result<()> {
        require!(amount > 0, MinesError::InvalidParam);
        invoke(
            &system_instruction::transfer(&ctx.accounts.funder.key(), &ctx.accounts.vault.key(), amount),
            &[
                ctx.accounts.funder.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        emit!(BankrollDeposited { funder: ctx.accounts.funder.key(), amount });
        Ok(())
    }

    pub fn withdraw_bankroll(ctx: Context<WithdrawBankroll>, amount: u64) -> Result<()> {
        require!(amount > 0, MinesError::InvalidParam);
        require!(ctx.accounts.vault.to_account_info().lamports() >= amount, MinesError::InsufficientBankroll);
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.treasury_authority.to_account_info().try_borrow_mut_lamports()? += amount;
        emit!(BankrollWithdrawn { treasury_authority: ctx.accounts.treasury_authority.key(), amount });
        Ok(())
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PausedSet { paused });
        Ok(())
    }

    /// Admin-only tuning knob: min_bet/max_bet were only settable once at
    /// initialize_config, which forces a full re-init cycle just to react
    /// to bankroll size changing. The payout cap (PAYOUT_CAP_DIVISOR) only
    /// works as a rare safety net if max_bet stays small relative to the
    /// live bankroll — this is how an operator keeps that ratio sane as the
    /// bankroll grows or shrinks, without redeploying.
    pub fn update_limits(ctx: Context<UpdateLimits>, min_bet: u64, max_bet: u64) -> Result<()> {
        require!(min_bet > 0 && min_bet <= max_bet, MinesError::InvalidParam);
        let config = &mut ctx.accounts.config;
        config.min_bet = min_bet;
        config.max_bet = max_bet;
        emit!(LimitsUpdated { min_bet, max_bet });
        Ok(())
    }

    // -----------------------------------------------------------------
    // Wykop (time-based mining)
    // -----------------------------------------------------------------

    /// One-time admin setup for the Wykop game mode, kept as a separate
    /// account from `Config` (not a migration of it) — `Config` already has
    /// a hand-computed `LEN` for an already-initialized live PDA, and
    /// extending that would need account reallocation. A fresh, generously
    /// reserved account is simpler and matches how `Vault`/`Round` were
    /// already split out.
    pub fn initialize_dig_config(
        ctx: Context<InitializeDigConfig>,
        tier_prices: [u64; DIG_TIER_COUNT],
        tier_durations: [u32; DIG_TIER_COUNT],
        rarity_tiers: Vec<RarityTier>,
    ) -> Result<()> {
        require!(rarity_tiers.len() <= MAX_RARITY_TIERS, MinesError::InvalidParam);
        require!(tier_prices.iter().all(|&p| p > 0), MinesError::InvalidParam);

        let dig_config = &mut ctx.accounts.dig_config;
        dig_config.admin = ctx.accounts.admin.key();
        dig_config.tier_prices = tier_prices;
        dig_config.tier_durations = tier_durations;
        dig_config.mine_mint = ctx.accounts.config.mine_mint;
        dig_config.total_sessions = 0;
        dig_config.bump = ctx.bumps["dig_config"];

        let mut tiers = [RarityTier::default(); MAX_RARITY_TIERS];
        for (i, t) in rarity_tiers.iter().enumerate() {
            tiers[i] = *t;
        }
        dig_config.rarity_tiers = tiers;
        dig_config.active_rarity_count = rarity_tiers.len() as u8;

        emit!(DigConfigInitialized {
            tier_prices,
            tier_durations,
            active_rarity_count: dig_config.active_rarity_count,
        });
        Ok(())
    }

    /// Admin-only: repriced/retimed duration tiers without touching rarity
    /// odds. Same tuning-knob pattern as `update_limits`.
    pub fn update_dig_tiers(
        ctx: Context<UpdateDigTiers>,
        tier_prices: [u64; DIG_TIER_COUNT],
        tier_durations: [u32; DIG_TIER_COUNT],
    ) -> Result<()> {
        let dig_config = &mut ctx.accounts.dig_config;
        dig_config.tier_prices = tier_prices;
        dig_config.tier_durations = tier_durations;
        emit!(DigTiersUpdated { tier_prices, tier_durations });
        Ok(())
    }

    /// Admin-only: this is how a 3rd/4th/5th rarity tier gets added later —
    /// writes into the reserved-but-unused slots of `rarity_tiers`, no
    /// redeploy or migration needed.
    pub fn update_rarity_tiers(ctx: Context<UpdateRarityTiers>, rarity_tiers: Vec<RarityTier>) -> Result<()> {
        require!(rarity_tiers.len() <= MAX_RARITY_TIERS, MinesError::InvalidParam);
        let dig_config = &mut ctx.accounts.dig_config;
        let mut tiers = [RarityTier::default(); MAX_RARITY_TIERS];
        for (i, t) in rarity_tiers.iter().enumerate() {
            tiers[i] = *t;
        }
        dig_config.rarity_tiers = tiers;
        dig_config.active_rarity_count = rarity_tiers.len() as u8;
        emit!(RarityTiersUpdated { active_rarity_count: dig_config.active_rarity_count });
        Ok(())
    }

    /// Player pays for a dig session. Bumps the *same* `Config.cumulative_volume`
    /// Mines uses for its emission halving curve — Wykop deliberately does not
    /// have its own independent emission schedule, so adding this game mode
    /// doesn't double the rate new $MINE enters circulation.
    pub fn start_dig(ctx: Context<StartDig>, duration_tier: u8, client_seed: [u8; 32]) -> Result<()> {
        require!((duration_tier as usize) < DIG_TIER_COUNT, MinesError::InvalidParam);
        let config = &mut ctx.accounts.config;
        require!(!config.paused, MinesError::Paused);
        require!(config.current_seed_hash != [0u8; 32], MinesError::NoSeedCommitted);

        let dig_config = &mut ctx.accounts.dig_config;
        let price = dig_config.tier_prices[duration_tier as usize];

        // Wykop's whole wager is unencumbered revenue (resolve_dig never
        // draws XNT back out) — see route_wykop_wager / WYKOP_*_BPS for the
        // confirmed 40% staking / 25% buyback+burn / 25% liquidity / 10%
        // vault split, very different from Mines' route_wager_skim.
        route_wykop_wager(
            price,
            &ctx.accounts.player.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.reward_vault.to_account_info(),
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.pool_xnt_vault.to_account_info(),
            &ctx.accounts.pool_mine_vault.to_account_info(),
            ctx.accounts.pool_mine_vault.amount,
            &ctx.accounts.mine_mint.to_account_info(),
            &ctx.accounts.pool_authority.to_account_info(),
            ctx.accounts.liquidity_pool.pool_authority_bump,
            &ctx.accounts.token_program.to_account_info(),
            &mut ctx.accounts.staking_pool,
        )?;

        config.cumulative_volume = config.cumulative_volume.saturating_add(price);

        let session_id = dig_config.total_sessions;
        dig_config.total_sessions = dig_config.total_sessions.checked_add(1).ok_or(MinesError::MathOverflow)?;

        let session = &mut ctx.accounts.session;
        session.player = ctx.accounts.player.key();
        session.session_id = session_id;
        session.duration_tier = duration_tier;
        session.bet_amount = price;
        session.start_ts = Clock::get()?.unix_timestamp;
        session.seed_commitment = config.current_seed_hash;
        session.client_seed = client_seed;
        session.status = DigStatus::Active as u8;
        session.rarity_hit = RARITY_NONE;
        session.bump = ctx.bumps["session"];

        emit!(DigStarted {
            session: session.key(),
            player: session.player,
            session_id,
            duration_tier,
            bet_amount: price,
            seed_commitment: session.seed_commitment,
        });
        Ok(())
    }

    /// Resolver-signed settlement, called once the session's real-time
    /// duration has actually elapsed (enforced on-chain, not just trusted
    /// client-side) — mints `floor + bonus` directly to the player's ATA in
    /// this single instruction, so Wykop costs exactly one player
    /// transaction total (`start_dig`), same "cut unnecessary transactions"
    /// lesson learned from Mines' `resolve_reveal`.
    ///
    /// The floor amount is computed here on-chain from `bet_amount` and the
    /// shared emission curve — the resolver cannot shortchange it. Only
    /// `rarity_hit` (which bonus tier, if any) is resolver-attested, since
    /// only the resolver's secret seed can produce that roll — same trust
    /// boundary as `is_mine` in `resolve_reveal`.
    pub fn resolve_dig(ctx: Context<ResolveDig>, rarity_hit: u8) -> Result<()> {
        let session = &mut ctx.accounts.session;
        require!(session.status == DigStatus::Active as u8, MinesError::RoundNotActive);

        let dig_config = &ctx.accounts.dig_config;
        let elapsed = Clock::get()?.unix_timestamp - session.start_ts;
        let required = dig_config.tier_durations[session.duration_tier as usize] as i64;
        require!(elapsed >= required, MinesError::DigNotFinished);

        require!(
            rarity_hit == RARITY_NONE || (rarity_hit as usize) < dig_config.active_rarity_count as usize,
            MinesError::InvalidParam
        );

        let config = &ctx.accounts.config;
        let rate = emission_rate_scaled(config.cumulative_volume);
        // This used to *be* the $MINE amount directly (price-blind — the
        // volume-based supply curve controls scarcity, but says nothing
        // about whether that many tokens are actually worth what was paid
        // if the market price moves). Now it's an XNT-VALUE TARGET: the
        // volume curve still controls how much *value* a dig is worth
        // (same halving-schedule scarcity story), but the actual token
        // count self-adjusts against the pool's live spot price, so a dig
        // stays worth roughly the same in real terms whether $MINE's price
        // has gone up or down. Falls back to the old price-blind behavior
        // if the pool has no reserves yet (e.g. not initialized), so this
        // never breaks Wykop's core loop on a missing/empty market.
        let target_xnt_value = (session.bet_amount as u128)
            .checked_mul(rate)
            .ok_or(MinesError::MathOverflow)?
            .checked_div(EMISSION_SCALE)
            .ok_or(MinesError::MathOverflow)?;

        let reserve_xnt = ctx.accounts.pool_xnt_vault.to_account_info().lamports();
        let reserve_mine = ctx.accounts.pool_mine_vault.amount;
        let floor_amount: u64 = if reserve_xnt > 0 && reserve_mine > 0 {
            mine_amount_for_xnt_value(target_xnt_value, reserve_xnt, reserve_mine)?
        } else {
            target_xnt_value.try_into().map_err(|_| MinesError::MathOverflow)?
        };

        let bonus_amount: u64 = if rarity_hit != RARITY_NONE {
            let tier = dig_config.rarity_tiers[rarity_hit as usize];
            ((floor_amount as u128)
                .checked_mul(tier.reward_bps as u128)
                .ok_or(MinesError::MathOverflow)?
                .checked_div(10_000)
                .ok_or(MinesError::MathOverflow)?)
            .try_into()
            .map_err(|_| MinesError::MathOverflow)?
        } else {
            0
        };

        let total_mint = floor_amount.checked_add(bonus_amount).ok_or(MinesError::MathOverflow)?;

        if total_mint > 0 {
            let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &[config.mint_authority_bump]];
            let signer = &[seeds];
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.mine_mint.to_account_info(),
                        to: ctx.accounts.player_mine_ata.to_account_info(),
                        authority: ctx.accounts.mint_authority.to_account_info(),
                    },
                    signer,
                ),
                total_mint,
            )?;
        }

        session.status = DigStatus::Resolved as u8;
        session.rarity_hit = rarity_hit;

        emit!(DigResolved {
            session: session.key(),
            session_id: session.session_id,
            player: session.player,
            rarity_hit,
            floor_amount,
            bonus_amount,
        });
        Ok(())
    }

    // -----------------------------------------------------------------
    // $MINE staking v3 — real XNT yield, funded automatically from a
    // small skim taken off every Mines/Wykop wager (see `route_wager_skim`,
    // called from `start_round`/`start_dig`), not from token emission.
    // Rewards are a pro-rata share of whatever XNT actually arrived
    // (Synthetix/MasterChef accumulator pattern, denominated per unit of
    // *weight*) — deliberately *not* a fixed or promised rate, closing off
    // the "buy the floor, stake it, yield more than you paid" arbitrage
    // without needing a $MINE/XNT price oracle at all.
    //
    // A wallet can open any number of concurrent positions, each tracked
    // and accruing independently:
    //   - `open_lock`: lock $MINE for a chosen duration tier — longer
    //     lock = higher weight multiplier on the SAME tokens, redeemable
    //     back to the owner via `expire_position` once the lock elapses.
    //   - `open_burn`: permanently destroy $MINE for a weight boost that
    //     is itself time-limited too, but on an INVERSE curve from lock
    //     tiers — short duration = high multiplier, long = low. The
    //     tokens never come back either way; only the *weight* expires.
    //     Without the inversion there'd be no real trade-off (burn's cost
    //     is already paid up front, so "longer AND bigger" would always
    //     dominate); with it, picking a burn tier is a genuine choice
    //     between a short strong burst and a longer gentler one.
    // `expire_position` removes a position's weight from the pool once its
    // `unlock_at` passes — callable by ANYONE, not just the owner, so a
    // keeper/cron process can sweep expired weight even if the owner never
    // comes back to do it. This also bounds how long any one position can
    // dominate the reward pool, unlike the old permanent-burn design.
    // -----------------------------------------------------------------

    pub fn initialize_staking_pool(
        ctx: Context<InitializeStakingPool>,
        lock_tiers: Vec<LockTier>,
        burn_tiers: Vec<BurnTier>,
        skim_bps: u16,
    ) -> Result<()> {
        require!(lock_tiers.len() <= MAX_LOCK_TIERS, MinesError::InvalidParam);
        require!(burn_tiers.len() <= MAX_BURN_TIERS, MinesError::InvalidParam);
        require!(skim_bps < 10_000, MinesError::InvalidParam);

        let pool = &mut ctx.accounts.staking_pool;
        pool.admin = ctx.accounts.admin.key();
        pool.mine_mint = ctx.accounts.config.mine_mint;
        pool.stake_token_vault = ctx.accounts.stake_token_vault.key();
        pool.total_weight = 0;
        pool.acc_reward_per_weight = 0;
        pool.unallocated_rewards = 0;
        pool.skim_bps = skim_bps;
        pool.total_positions = 0;
        pool.bump = ctx.bumps["staking_pool"];
        pool.reward_vault_bump = ctx.bumps["reward_vault"];
        pool.staking_authority_bump = ctx.bumps["staking_authority"];
        ctx.accounts.reward_vault.bump = ctx.bumps["reward_vault"];

        let mut lock = [LockTier::default(); MAX_LOCK_TIERS];
        for (i, t) in lock_tiers.iter().enumerate() {
            lock[i] = *t;
        }
        pool.lock_tiers = lock;
        pool.active_lock_tier_count = lock_tiers.len() as u8;

        let mut burn = [BurnTier::default(); MAX_BURN_TIERS];
        for (i, t) in burn_tiers.iter().enumerate() {
            burn[i] = *t;
        }
        pool.burn_tiers = burn;
        pool.active_burn_tier_count = burn_tiers.len() as u8;

        emit!(StakingPoolInitialized {
            skim_bps,
            active_lock_tier_count: pool.active_lock_tier_count,
            active_burn_tier_count: pool.active_burn_tier_count,
        });
        Ok(())
    }

    /// Admin-only tuning knob for the skim rate — lock/burn tiers
    /// themselves aren't updatable in v1 (kept simple; positions already
    /// snapshot their multiplier at open time so changing the menu later
    /// wouldn't retroactively affect them anyway).
    pub fn update_staking_params(ctx: Context<UpdateStakingParams>, skim_bps: u16) -> Result<()> {
        require!(skim_bps < 10_000, MinesError::InvalidParam);
        let pool = &mut ctx.accounts.staking_pool;
        pool.skim_bps = skim_bps;
        emit!(StakingParamsUpdated { skim_bps });
        Ok(())
    }

    pub fn open_lock(ctx: Context<OpenLock>, amount: u64, lock_tier: u8) -> Result<()> {
        require!(amount > 0, MinesError::InvalidParam);
        let pool = &mut ctx.accounts.staking_pool;
        require!((lock_tier as usize) < pool.active_lock_tier_count as usize, MinesError::InvalidParam);
        settle_unallocated(pool)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.staker_mine_ata.to_account_info(),
                    to: ctx.accounts.stake_token_vault.to_account_info(),
                    authority: ctx.accounts.staker.to_account_info(),
                },
            ),
            amount,
        )?;

        let tier = pool.lock_tiers[lock_tier as usize];
        let weight = (amount as u128)
            .checked_mul(tier.weight_multiplier_bps as u128)
            .ok_or(MinesError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(MinesError::MathOverflow)?;

        let position_id = pool.total_positions;
        pool.total_positions = pool.total_positions.checked_add(1).ok_or(MinesError::MathOverflow)?;
        pool.total_weight = pool.total_weight.checked_add(weight).ok_or(MinesError::MathOverflow)?;

        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.staker.key();
        position.position_id = position_id;
        position.kind = PositionKind::Lock;
        position.amount = amount;
        position.weight = weight;
        position.unlock_at = Clock::get()?.unix_timestamp + tier.duration_seconds as i64;
        position.reward_debt = weight_reward_debt(weight, pool.acc_reward_per_weight)?;
        position.unclaimed_lamports = 0;
        position.expired = false;
        position.bump = ctx.bumps["position"];

        emit!(PositionOpened {
            owner: position.owner,
            position_id,
            kind: PositionKind::Lock as u8,
            amount,
            tier: lock_tier,
            weight,
            unlock_at: position.unlock_at,
        });
        Ok(())
    }

    /// Burns `amount` $MINE immediately (irreversible — the tokens never
    /// come back, on any tier) in exchange for a weight boost that lasts
    /// until `unlock_at`, at which point `expire_position` removes it from
    /// the pool. See the module-level comment above for why the tier
    /// curve is inverted from lock tiers (short = high multiplier).
    pub fn open_burn(ctx: Context<OpenBurn>, amount: u64, burn_tier: u8) -> Result<()> {
        require!(amount > 0, MinesError::InvalidParam);
        let pool = &mut ctx.accounts.staking_pool;
        require!((burn_tier as usize) < pool.active_burn_tier_count as usize, MinesError::InvalidParam);
        settle_unallocated(pool)?;

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: ctx.accounts.mine_mint.to_account_info(),
                    from: ctx.accounts.staker_mine_ata.to_account_info(),
                    authority: ctx.accounts.staker.to_account_info(),
                },
            ),
            amount,
        )?;

        let tier = pool.burn_tiers[burn_tier as usize];
        let weight = (amount as u128)
            .checked_mul(tier.weight_multiplier_bps as u128)
            .ok_or(MinesError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(MinesError::MathOverflow)?;

        let position_id = pool.total_positions;
        pool.total_positions = pool.total_positions.checked_add(1).ok_or(MinesError::MathOverflow)?;
        pool.total_weight = pool.total_weight.checked_add(weight).ok_or(MinesError::MathOverflow)?;

        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.staker.key();
        position.position_id = position_id;
        position.kind = PositionKind::Burn;
        position.amount = amount;
        position.weight = weight;
        position.unlock_at = Clock::get()?.unix_timestamp + tier.duration_seconds as i64;
        position.reward_debt = weight_reward_debt(weight, pool.acc_reward_per_weight)?;
        position.unclaimed_lamports = 0;
        position.expired = false;
        position.bump = ctx.bumps["position"];

        emit!(PositionOpened {
            owner: position.owner,
            position_id,
            kind: PositionKind::Burn as u8,
            amount,
            tier: burn_tier,
            weight,
            unlock_at: position.unlock_at,
        });
        Ok(())
    }

    /// Removes an expired position's weight from the pool and, for a Lock,
    /// returns the principal $MINE to its owner — callable by ANYONE once
    /// `unlock_at` has passed, not just the position's owner, so a
    /// keeper/cron process can sweep expired positions automatically. This
    /// is safe to be permissionless: a Burn position has no funds left to
    /// move (already destroyed at open_burn time), and a Lock's principal
    /// always flows to `position.owner`'s own ATA regardless of who calls
    /// this — the caller pays the tx fee and gets nothing else.
    pub fn expire_position(ctx: Context<ExpirePosition>) -> Result<()> {
        let pool = &mut ctx.accounts.staking_pool;
        settle_unallocated(pool)?;

        let position = &mut ctx.accounts.position;
        require!(!position.expired, MinesError::AlreadyExpired);
        require!(Clock::get()?.unix_timestamp >= position.unlock_at, MinesError::StakeLocked);

        let pending = pending_reward(position.weight, pool.acc_reward_per_weight, position.reward_debt)?;
        position.unclaimed_lamports = position.unclaimed_lamports.checked_add(pending).ok_or(MinesError::MathOverflow)?;
        pool.total_weight = pool.total_weight.checked_sub(position.weight).ok_or(MinesError::MathOverflow)?;

        if position.kind == PositionKind::Lock {
            let amount = position.amount;
            let seeds: &[&[u8]] = &[STAKING_AUTHORITY_SEED, &[pool.staking_authority_bump]];
            let signer = &[seeds];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: ctx.accounts.stake_token_vault.to_account_info(),
                        to: ctx.accounts.owner_mine_ata.to_account_info(),
                        authority: ctx.accounts.staking_authority.to_account_info(),
                    },
                    signer,
                ),
                amount,
            )?;
        }

        position.expired = true;
        position.weight = 0;
        position.reward_debt = weight_reward_debt(0, pool.acc_reward_per_weight)?;

        emit!(PositionExpired { owner: position.owner, position_id: position.position_id, kind: position.kind as u8 });
        Ok(())
    }

    /// The only staking instruction that ever moves lamports — bundles
    /// whatever's been banked in `unclaimed_lamports` (from open_lock/
    /// open_burn/expire_position, which never touch lamports directly)
    /// plus anything newly accrued since, and pays it all out in one
    /// transfer. No SPL token CPI happens in this instruction. Works the
    /// same whether the position is still active or already expired — an
    /// expired position's weight is 0, so it simply stops accruing
    /// anything new, but whatever was banked before expiry is still owed.
    pub fn claim_yield(ctx: Context<ClaimYield>, _position_id: u64) -> Result<()> {
        let pool = &mut ctx.accounts.staking_pool;
        settle_unallocated(pool)?;

        let position = &mut ctx.accounts.position;
        let newly_accrued = pending_reward(position.weight, pool.acc_reward_per_weight, position.reward_debt)?;
        let total_pending = position.unclaimed_lamports.checked_add(newly_accrued).ok_or(MinesError::MathOverflow)?;
        require!(total_pending > 0, MinesError::NothingToCashOut);

        pay_from_reward_vault(&ctx.accounts.reward_vault.to_account_info(), &ctx.accounts.staker.to_account_info(), total_pending)?;
        position.unclaimed_lamports = 0;
        position.reward_debt = weight_reward_debt(position.weight, pool.acc_reward_per_weight)?;

        emit!(YieldClaimed { owner: position.owner, amount: total_pending });
        Ok(())
    }

    // -----------------------------------------------------------------
    // $MINE/XNT liquidity pool (Phase C) — a minimal constant-product AMM
    // whose only job is giving the program a real, observable market price
    // for $MINE. This is what Wykop's floor (see `resolve_dig` — modified
    // below) and `buyback_and_burn` actually needed: without *some* real
    // market, "price-aware floor" and "buy back and burn" are both
    // meaningless, there's nothing to price against or buy from.
    //
    // Deliberately no separate LP-share accounting for v1 — admin/treasury
    // is the only liquidity provider (seeded once at init), reserves are
    // just read live off the vault balances. Supporting other LPs is a
    // real feature but not one anything here needs yet.
    // -----------------------------------------------------------------

    pub fn initialize_liquidity_pool(
        ctx: Context<InitializeLiquidityPool>,
        initial_xnt: u64,
        initial_mine: u64,
    ) -> Result<()> {
        require!(initial_xnt > 0 && initial_mine > 0, MinesError::InvalidParam);

        let pool = &mut ctx.accounts.pool;
        pool.mine_mint = ctx.accounts.mine_mint.key();
        pool.mine_vault = ctx.accounts.pool_mine_vault.key();
        pool.xnt_vault_bump = ctx.bumps["pool_xnt_vault"];
        pool.pool_authority_bump = ctx.bumps["pool_authority"];
        pool.bump = ctx.bumps["pool"];
        pool.total_xnt_volume = 0;
        ctx.accounts.pool_xnt_vault.bump = ctx.bumps["pool_xnt_vault"];

        invoke(
            &system_instruction::transfer(&ctx.accounts.admin.key(), &ctx.accounts.pool_xnt_vault.key(), initial_xnt),
            &[
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.pool_xnt_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.admin_mine_ata.to_account_info(),
                    to: ctx.accounts.pool_mine_vault.to_account_info(),
                    authority: ctx.accounts.admin.to_account_info(),
                },
            ),
            initial_mine,
        )?;

        emit!(LiquidityPoolInitialized { initial_xnt, initial_mine });
        Ok(())
    }

    pub fn swap_xnt_for_mine(ctx: Context<SwapXntForMine>, xnt_in: u64, min_mine_out: u64) -> Result<()> {
        require!(xnt_in > 0, MinesError::InvalidParam);
        let reserve_xnt = ctx.accounts.pool_xnt_vault.to_account_info().lamports();
        let reserve_mine = ctx.accounts.pool_mine_vault.amount;
        require!(reserve_xnt > 0 && reserve_mine > 0, MinesError::PoolEmpty);

        let mine_out = constant_product_out(xnt_in, reserve_xnt, reserve_mine)?;
        require!(mine_out >= min_mine_out, MinesError::SlippageExceeded);
        require!(mine_out < reserve_mine, MinesError::PoolEmpty);

        invoke(
            &system_instruction::transfer(&ctx.accounts.trader.key(), &ctx.accounts.pool_xnt_vault.key(), xnt_in),
            &[
                ctx.accounts.trader.to_account_info(),
                ctx.accounts.pool_xnt_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let pool = &mut ctx.accounts.pool;
        let seeds: &[&[u8]] = &[POOL_AUTHORITY_SEED, &[pool.pool_authority_bump]];
        let signer = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pool_mine_vault.to_account_info(),
                    to: ctx.accounts.trader_mine_ata.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                signer,
            ),
            mine_out,
        )?;

        pool.total_xnt_volume = pool.total_xnt_volume.saturating_add(xnt_in);
        emit!(SwappedXntForMine { trader: ctx.accounts.trader.key(), xnt_in, mine_out });
        Ok(())
    }

    pub fn swap_mine_for_xnt(ctx: Context<SwapMineForXnt>, mine_in: u64, min_xnt_out: u64) -> Result<()> {
        require!(mine_in > 0, MinesError::InvalidParam);
        let reserve_xnt = ctx.accounts.pool_xnt_vault.to_account_info().lamports();
        let reserve_mine = ctx.accounts.pool_mine_vault.amount;
        require!(reserve_xnt > 0 && reserve_mine > 0, MinesError::PoolEmpty);

        let xnt_out = constant_product_out(mine_in, reserve_mine, reserve_xnt)?;
        require!(xnt_out >= min_xnt_out, MinesError::SlippageExceeded);
        require!(xnt_out < reserve_xnt, MinesError::PoolEmpty);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.trader_mine_ata.to_account_info(),
                    to: ctx.accounts.pool_mine_vault.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            mine_in,
        )?;

        **ctx.accounts.pool_xnt_vault.to_account_info().try_borrow_mut_lamports()? -= xnt_out;
        **ctx.accounts.trader.to_account_info().try_borrow_mut_lamports()? += xnt_out;

        let pool = &mut ctx.accounts.pool;
        pool.total_xnt_volume = pool.total_xnt_volume.saturating_add(xnt_out);
        emit!(SwappedMineForXnt { trader: ctx.accounts.trader.key(), mine_in, xnt_out });
        Ok(())
    }

    /// Treasury-operated: takes XNT already sitting in the shared game
    /// `vault` (accumulated house edge), swaps it into the liquidity pool
    /// for $MINE at the current spot price, and burns it — permanently
    /// reduces supply and pushes the pool's spot price up, a direct,
    /// real counter-pressure against sell pressure (complements staking,
    /// which slows selling but doesn't reduce supply).
    pub fn buyback_and_burn(ctx: Context<BuybackAndBurn>, xnt_amount: u64) -> Result<()> {
        require!(xnt_amount > 0, MinesError::InvalidParam);
        require!(ctx.accounts.vault.to_account_info().lamports() >= xnt_amount, MinesError::InsufficientBankroll);

        let reserve_xnt = ctx.accounts.pool_xnt_vault.to_account_info().lamports();
        let reserve_mine = ctx.accounts.pool_mine_vault.amount;
        require!(reserve_xnt > 0 && reserve_mine > 0, MinesError::PoolEmpty);

        let mine_out = constant_product_out(xnt_amount, reserve_xnt, reserve_mine)?;
        require!(mine_out > 0 && mine_out < reserve_mine, MinesError::PoolEmpty);

        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= xnt_amount;
        **ctx.accounts.pool_xnt_vault.to_account_info().try_borrow_mut_lamports()? += xnt_amount;

        let pool = &mut ctx.accounts.pool;
        let seeds: &[&[u8]] = &[POOL_AUTHORITY_SEED, &[pool.pool_authority_bump]];
        let signer = &[seeds];
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: ctx.accounts.mine_mint.to_account_info(),
                    from: ctx.accounts.pool_mine_vault.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                signer,
            ),
            mine_out,
        )?;

        pool.total_xnt_volume = pool.total_xnt_volume.saturating_add(xnt_amount);
        emit!(BuybackAndBurned { xnt_amount, mine_burned: mine_out });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(init, payer = admin, space = Config::LEN, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,

    // Must be `init` (program-owned), not a bare System-owned PDA: the
    // runtime only allows a program to *debit* an account's lamports via
    // direct pointer arithmetic (as cash_out/withdraw_bankroll do) if that
    // program owns the account. Crediting it (player deposits) works either
    // way, but a System-owned vault would make every payout fail at runtime.
    #[account(init, payer = admin, space = Vault::LEN, seeds = [VAULT_SEED], bump)]
    pub vault: Account<'info, Vault>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeMint<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,

    /// CHECK: signer-only PDA used to authorize $MINE mint_to CPIs.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = mint_authority,
        seeds = [MINT_SEED],
        bump
    )]
    pub mine_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializePools<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,

    #[account(address = config.mine_mint)]
    pub mine_mint: Box<Account<'info, Mint>>,

    #[account(init, payer = admin, token::mint = mine_mint, token::authority = config)]
    pub leaderboard_pool: Box<Account<'info, TokenAccount>>,

    #[account(init, payer = admin, token::mint = mine_mint, token::authority = config)]
    pub rakeback_pool: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CommitSeed<'info> {
    pub resolver_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = resolver_authority)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct RevealSeed<'info> {
    pub resolver_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = resolver_authority)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(bet_amount: u64, mine_count: u8, client_seed: [u8; 32])]
pub struct StartRound<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        init,
        payer = player,
        space = Round::LEN,
        seeds = [ROUND_SEED, &config.total_rounds.to_le_bytes()],
        bump
    )]
    pub round: Box<Account<'info, Round>>,

    #[account(mut, seeds = [STAKING_POOL_SEED], bump = staking_pool.bump)]
    pub staking_pool: Box<Account<'info, StakingPool>>,

    #[account(mut, seeds = [REWARD_VAULT_SEED], bump = staking_pool.reward_vault_bump)]
    pub reward_vault: Box<Account<'info, RewardVault>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveReveal<'info> {
    pub resolver_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = resolver_authority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [ROUND_SEED, &round.round_id.to_le_bytes()], bump = round.bump)]
    pub round: Account<'info, Round>,
}

#[derive(Accounts)]
pub struct CashOut<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: Account<'info, Vault>,

    #[account(mut, has_one = player, seeds = [ROUND_SEED, &round.round_id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,

    #[account(mut, address = config.mine_mint)]
    pub mine_mint: Box<Account<'info, Mint>>,

    /// CHECK: signer-only PDA authorizing mint_to CPIs.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump = config.mint_authority_bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = player,
        associated_token::mint = mine_mint,
        associated_token::authority = player
    )]
    pub player_mine_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = config.leaderboard_pool)]
    pub leaderboard_pool: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = config.rakeback_pool)]
    pub rakeback_pool: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositBankroll<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawBankroll<'info> {
    #[account(mut)]
    pub treasury_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = treasury_authority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct UpdateLimits<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct InitializeDigConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,

    #[account(init, payer = admin, space = DigConfig::LEN, seeds = [DIG_CONFIG_SEED], bump)]
    pub dig_config: Box<Account<'info, DigConfig>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateDigTiers<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [DIG_CONFIG_SEED], bump = dig_config.bump, has_one = admin)]
    pub dig_config: Box<Account<'info, DigConfig>>,
}

#[derive(Accounts)]
pub struct UpdateRarityTiers<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [DIG_CONFIG_SEED], bump = dig_config.bump, has_one = admin)]
    pub dig_config: Box<Account<'info, DigConfig>>,
}

#[derive(Accounts)]
pub struct StartDig<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [DIG_CONFIG_SEED], bump = dig_config.bump)]
    pub dig_config: Box<Account<'info, DigConfig>>,

    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        init,
        payer = player,
        space = DigSession::LEN,
        seeds = [DIG_SESSION_SEED, &dig_config.total_sessions.to_le_bytes()],
        bump
    )]
    pub session: Box<Account<'info, DigSession>>,

    #[account(mut, address = config.mine_mint)]
    pub mine_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = player,
        associated_token::mint = mine_mint,
        associated_token::authority = player
    )]
    pub player_mine_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut, seeds = [STAKING_POOL_SEED], bump = staking_pool.bump)]
    pub staking_pool: Box<Account<'info, StakingPool>>,

    #[account(mut, seeds = [REWARD_VAULT_SEED], bump = staking_pool.reward_vault_bump)]
    pub reward_vault: Box<Account<'info, RewardVault>>,

    // Needed for route_wykop_wager's automatic buyback-and-burn + liquidity
    // top-up — required, not optional, same as ResolveDig's pool accounts
    // (this program's operator seeds the liquidity pool immediately after
    // deploying, before any dig can be started).
    #[account(mut, seeds = [POOL_XNT_VAULT_SEED], bump = liquidity_pool.xnt_vault_bump)]
    pub pool_xnt_vault: Box<Account<'info, Vault>>,

    #[account(mut, address = liquidity_pool.mine_vault)]
    pub pool_mine_vault: Box<Account<'info, TokenAccount>>,

    #[account(seeds = [LIQUIDITY_POOL_SEED], bump = liquidity_pool.bump)]
    pub liquidity_pool: Box<Account<'info, LiquidityPool>>,

    /// CHECK: signer-only PDA, see InitializeLiquidityPool.
    #[account(seeds = [POOL_AUTHORITY_SEED], bump = liquidity_pool.pool_authority_bump)]
    pub pool_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveDig<'info> {
    pub resolver_authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = resolver_authority)]
    pub config: Box<Account<'info, Config>>,

    #[account(seeds = [DIG_CONFIG_SEED], bump = dig_config.bump)]
    pub dig_config: Box<Account<'info, DigConfig>>,

    #[account(mut, seeds = [DIG_SESSION_SEED, &session.session_id.to_le_bytes()], bump = session.bump)]
    pub session: Box<Account<'info, DigSession>>,

    #[account(mut, address = config.mine_mint)]
    pub mine_mint: Box<Account<'info, Mint>>,

    /// CHECK: signer-only PDA authorizing mint_to CPIs, same one Mines uses.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump = config.mint_authority_bump)]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: not a signer here — only used to derive/validate the ATA
    /// address below. The player already authorized this session's
    /// existence by signing `start_dig`; the resolver never needs their
    /// signature again.
    #[account(address = session.player)]
    pub player: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = mine_mint, associated_token::authority = player)]
    pub player_mine_ata: Box<Account<'info, TokenAccount>>,

    /// Read-only — resolve_dig only reads live reserves to price the
    /// floor, never trades against the pool itself. Required (not
    /// optional): this program's operator initializes+seeds the liquidity
    /// pool immediately after deploying this, before any dig resolves.
    #[account(seeds = [POOL_XNT_VAULT_SEED], bump = liquidity_pool.xnt_vault_bump)]
    pub pool_xnt_vault: Box<Account<'info, Vault>>,

    #[account(address = liquidity_pool.mine_vault)]
    pub pool_mine_vault: Box<Account<'info, TokenAccount>>,

    #[account(seeds = [LIQUIDITY_POOL_SEED], bump = liquidity_pool.bump)]
    pub liquidity_pool: Box<Account<'info, LiquidityPool>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializeStakingPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,

    #[account(init, payer = admin, space = StakingPool::LEN, seeds = [STAKING_POOL_SEED], bump)]
    pub staking_pool: Box<Account<'info, StakingPool>>,

    /// CHECK: signer-only PDA authorizing $MINE transfers out of
    /// stake_token_vault on unstake.
    #[account(seeds = [STAKING_AUTHORITY_SEED], bump)]
    pub staking_authority: UncheckedAccount<'info>,

    #[account(init, payer = admin, space = RewardVault::LEN, seeds = [REWARD_VAULT_SEED], bump)]
    pub reward_vault: Box<Account<'info, RewardVault>>,

    #[account(address = config.mine_mint)]
    pub mine_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        token::mint = mine_mint,
        token::authority = staking_authority,
        seeds = [STAKE_TOKEN_VAULT_SEED],
        bump
    )]
    pub stake_token_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount: u64, lock_tier: u8)]
pub struct OpenLock<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(mut, seeds = [STAKING_POOL_SEED], bump = staking_pool.bump)]
    pub staking_pool: Box<Account<'info, StakingPool>>,

    #[account(
        init,
        payer = staker,
        space = Position::LEN,
        seeds = [POSITION_SEED, staker.key().as_ref(), &staking_pool.total_positions.to_le_bytes()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(mut, address = staking_pool.stake_token_vault)]
    pub stake_token_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, associated_token::mint = staking_pool.mine_mint, associated_token::authority = staker)]
    pub staker_mine_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount: u64, burn_tier: u8)]
pub struct OpenBurn<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(mut, seeds = [STAKING_POOL_SEED], bump = staking_pool.bump)]
    pub staking_pool: Box<Account<'info, StakingPool>>,

    #[account(
        init,
        payer = staker,
        space = Position::LEN,
        seeds = [POSITION_SEED, staker.key().as_ref(), &staking_pool.total_positions.to_le_bytes()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(mut, address = staking_pool.mine_mint)]
    pub mine_mint: Box<Account<'info, Mint>>,

    #[account(mut, associated_token::mint = staking_pool.mine_mint, associated_token::authority = staker)]
    pub staker_mine_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExpirePosition<'info> {
    /// Anyone can pay for this — the position's owner, or a keeper/cron
    /// process. See the comment on `expire_position` for why that's safe.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [STAKING_POOL_SEED], bump = staking_pool.bump)]
    pub staking_pool: Box<Account<'info, StakingPool>>,

    #[account(
        mut,
        seeds = [POSITION_SEED, position.owner.as_ref(), &position.position_id.to_le_bytes()],
        bump = position.bump
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(mut, address = staking_pool.stake_token_vault)]
    pub stake_token_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: signer-only PDA, see InitializeStakingPool.
    #[account(seeds = [STAKING_AUTHORITY_SEED], bump = staking_pool.staking_authority_bump)]
    pub staking_authority: UncheckedAccount<'info>,

    /// The position owner's own $MINE ATA — a Lock's principal always
    /// lands here regardless of who signs `payer`. Not touched at all for
    /// a Burn position (already-destroyed tokens have nowhere to return
    /// to), but still required so the Accounts struct is uniform for both
    /// kinds.
    #[account(mut, associated_token::mint = staking_pool.mine_mint, associated_token::authority = position.owner)]
    pub owner_mine_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(position_id: u64)]
pub struct ClaimYield<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(seeds = [STAKING_POOL_SEED], bump = staking_pool.bump)]
    pub staking_pool: Box<Account<'info, StakingPool>>,

    #[account(
        mut,
        seeds = [POSITION_SEED, staker.key().as_ref(), &position_id.to_le_bytes()],
        bump = position.bump
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(mut, seeds = [REWARD_VAULT_SEED], bump = staking_pool.reward_vault_bump)]
    pub reward_vault: Box<Account<'info, RewardVault>>,
}

#[derive(Accounts)]
pub struct UpdateStakingParams<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [STAKING_POOL_SEED], bump = staking_pool.bump, has_one = admin)]
    pub staking_pool: Box<Account<'info, StakingPool>>,
}

#[derive(Accounts)]
pub struct InitializeLiquidityPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,

    #[account(init, payer = admin, space = LiquidityPool::LEN, seeds = [LIQUIDITY_POOL_SEED], bump)]
    pub pool: Box<Account<'info, LiquidityPool>>,

    /// CHECK: signer-only PDA authorizing $MINE transfers/burns out of
    /// pool_mine_vault.
    #[account(seeds = [POOL_AUTHORITY_SEED], bump)]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(init, payer = admin, space = Vault::LEN, seeds = [POOL_XNT_VAULT_SEED], bump)]
    pub pool_xnt_vault: Box<Account<'info, Vault>>,

    #[account(address = config.mine_mint)]
    pub mine_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        token::mint = mine_mint,
        token::authority = pool_authority,
        seeds = [POOL_MINE_VAULT_SEED],
        bump
    )]
    pub pool_mine_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, associated_token::mint = mine_mint, associated_token::authority = admin)]
    pub admin_mine_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SwapXntForMine<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(mut, seeds = [LIQUIDITY_POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, LiquidityPool>>,

    #[account(mut, seeds = [POOL_XNT_VAULT_SEED], bump = pool.xnt_vault_bump)]
    pub pool_xnt_vault: Box<Account<'info, Vault>>,

    #[account(mut, address = pool.mine_vault)]
    pub pool_mine_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: signer-only PDA, see InitializeLiquidityPool.
    #[account(seeds = [POOL_AUTHORITY_SEED], bump = pool.pool_authority_bump)]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = trader,
        associated_token::mint = mine_mint,
        associated_token::authority = trader
    )]
    pub trader_mine_ata: Box<Account<'info, TokenAccount>>,

    #[account(address = pool.mine_mint)]
    pub mine_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SwapMineForXnt<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(mut, seeds = [LIQUIDITY_POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, LiquidityPool>>,

    #[account(mut, seeds = [POOL_XNT_VAULT_SEED], bump = pool.xnt_vault_bump)]
    pub pool_xnt_vault: Box<Account<'info, Vault>>,

    #[account(mut, address = pool.mine_vault)]
    pub pool_mine_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, associated_token::mint = pool.mine_mint, associated_token::authority = trader)]
    pub trader_mine_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BuybackAndBurn<'info> {
    #[account(mut)]
    pub treasury_authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = treasury_authority)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(mut, seeds = [LIQUIDITY_POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, LiquidityPool>>,

    #[account(mut, seeds = [POOL_XNT_VAULT_SEED], bump = pool.xnt_vault_bump)]
    pub pool_xnt_vault: Box<Account<'info, Vault>>,

    #[account(mut, address = pool.mine_vault)]
    pub pool_mine_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: signer-only PDA, see InitializeLiquidityPool.
    #[account(seeds = [POOL_AUTHORITY_SEED], bump = pool.pool_authority_bump)]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut, address = pool.mine_mint)]
    pub mine_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub resolver_authority: Pubkey,
    pub treasury_authority: Pubkey,
    pub mine_mint: Pubkey,
    pub leaderboard_pool: Pubkey,
    pub rakeback_pool: Pubkey,
    pub house_edge_bps: u16,
    pub min_bet: u64,
    pub max_bet: u64,
    pub cumulative_volume: u64,
    pub total_rounds: u64,
    pub current_seed_hash: [u8; 32],
    pub seed_nonce: u64,
    pub paused: bool,
    pub bump: u8,
    pub vault_bump: u8,
    pub mint_authority_bump: u8,
}

impl Config {
    pub const LEN: usize = 8 + 6 * 32 + 32 + 2 + 5 * 8 + 1 + 3;
}

#[repr(u8)]
pub enum RoundStatus {
    Active = 0,
    CashedOut = 1,
    Busted = 2,
}

#[account]
pub struct Round {
    pub player: Pubkey,
    pub round_id: u64,
    pub bet_amount: u64,
    pub mine_count: u8,
    pub client_seed: [u8; 32],
    pub seed_commitment: [u8; 32],
    pub requested_bitmap: u32,
    pub revealed_bitmap: u32,
    pub revealed_count: u8,
    pub status: u8,
    pub bump: u8,
}

impl Round {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 1 + 32 + 32 + 4 + 4 + 1 + 1 + 1;
}

/// Program-owned holder of the native-lamport bankroll. Carries no real data
/// — it exists purely so the vault PDA is owned by this program, which is
/// required for cash_out/withdraw_bankroll to debit its lamports directly
/// (the runtime only allows a program to decrease an account's balance via
/// pointer arithmetic if that program owns the account; crediting it, e.g.
/// player deposits, has no such restriction).
#[account]
pub struct Vault {
    pub bump: u8,
}

impl Vault {
    pub const LEN: usize = 8 + 1;
}

/// One rarity tier's bonus payout, on top of the deterministic floor.
/// `reward_bps` is a *multiplier on the floor amount* (e.g. 20_000 = +200%,
/// i.e. floor x3 total) — this is the tier's fixed "size." How often it
/// hits is controlled separately in the resolver via `base_chance_bps` and
/// `duration_scaling`, which is where "longer dig = disproportionately
/// better odds" lives (a chance lever, not a size lever).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct RarityTier {
    pub reward_bps: u32,
    pub base_chance_bps: u16,
    pub duration_scaling: [u16; DIG_TIER_COUNT],
}

#[account]
pub struct DigConfig {
    pub admin: Pubkey,
    pub mine_mint: Pubkey,
    pub tier_prices: [u64; DIG_TIER_COUNT],
    pub tier_durations: [u32; DIG_TIER_COUNT],
    pub rarity_tiers: [RarityTier; MAX_RARITY_TIERS],
    pub active_rarity_count: u8,
    pub total_sessions: u64,
    pub bump: u8,
}

impl DigConfig {
    pub const LEN: usize = 8
        + 32 * 2
        + 8 * DIG_TIER_COUNT
        + 4 * DIG_TIER_COUNT
        + (4 + 2 + 2 * DIG_TIER_COUNT) * MAX_RARITY_TIERS
        + 1
        + 8
        + 1;
}

#[repr(u8)]
pub enum DigStatus {
    Active = 0,
    Resolved = 1,
}

#[account]
pub struct DigSession {
    pub player: Pubkey,
    pub session_id: u64,
    pub duration_tier: u8,
    pub bet_amount: u64,
    pub start_ts: i64,
    pub seed_commitment: [u8; 32],
    pub client_seed: [u8; 32],
    pub status: u8,
    pub rarity_hit: u8,
    pub bump: u8,
}

impl DigSession {
    pub const LEN: usize = 8 + 32 + 8 + 1 + 8 + 8 + 32 + 32 + 1 + 1 + 1;
}

#[account]
pub struct StakingPool {
    pub admin: Pubkey,
    pub mine_mint: Pubkey,
    pub stake_token_vault: Pubkey,
    /// Sum of every non-expired position's weight — reward distribution is
    /// proportional to WEIGHT, not raw staked/burned token count, which is
    /// what makes "lock longer = earn more" and "burn = earn even more (for
    /// a while)" both fall out of the same accumulator math.
    pub total_weight: u128,
    pub acc_reward_per_weight: u128,
    /// House-edge skim that arrived while total_weight was still zero
    /// (nowhere to attribute it to yet) — see `settle_unallocated`, swept
    /// in as soon as there's real weight to divide it across.
    pub unallocated_rewards: u64,
    pub lock_tiers: [LockTier; MAX_LOCK_TIERS],
    pub active_lock_tier_count: u8,
    /// Burn tiers — same shape as lock tiers, but the admin sets an
    /// INVERSE duration/multiplier curve (short = high, long = low). See
    /// the module comment above `open_burn` for why.
    pub burn_tiers: [BurnTier; MAX_BURN_TIERS],
    pub active_burn_tier_count: u8,
    /// % of every Mines/Wykop wager auto-routed here (see
    /// `route_wager_skim`), bps.
    pub skim_bps: u16,
    /// Global counter used as the third PDA seed component for `Position`
    /// accounts, letting any number of concurrent lock/burn positions
    /// exist per owner instead of one shared slot (mirrors DigConfig's
    /// `total_sessions` pattern).
    pub total_positions: u64,
    pub bump: u8,
    pub reward_vault_bump: u8,
    pub staking_authority_bump: u8,
}

impl StakingPool {
    pub const LEN: usize = 8
        + 32 * 3
        + 16
        + 16
        + 8
        + 8 * MAX_LOCK_TIERS
        + 1
        + 8 * MAX_BURN_TIERS
        + 1
        + 2
        + 8
        + 1
        + 1
        + 1;
}

/// One lock-duration option on the staking menu (e.g. 0/30/90/180 days).
/// `weight_multiplier_bps` is what makes longer locks earn a bigger share
/// of the same reward pool on the same underlying token amount.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct LockTier {
    pub duration_seconds: u32,
    pub weight_multiplier_bps: u32,
}

/// One time-limited burn option. Same shape as LockTier, but conceptually
/// inverted: `duration_seconds` here is how long the weight boost lasts
/// before `expire_position` removes it (the tokens are gone regardless,
/// from the moment of `open_burn`), and the admin is expected to set
/// SHORTER durations to HIGHER multipliers — see the module comment above
/// `open_burn`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct BurnTier {
    pub duration_seconds: u32,
    pub weight_multiplier_bps: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PositionKind {
    Lock,
    Burn,
}

/// A single lock or burn commitment. A wallet may hold any number of
/// these concurrently (each its own PDA, keyed by owner + a global
/// counter) — opening another lock or burn never touches existing ones.
#[account]
pub struct Position {
    pub owner: Pubkey,
    pub position_id: u64,
    pub kind: PositionKind,
    /// $MINE locked (kind = Lock, returned to owner by `expire_position`)
    /// or burned (kind = Burn, gone forever from the moment of
    /// `open_burn`) — kept for Burn mainly as a historical record.
    pub amount: u64,
    /// amount * the chosen tier's multiplier, snapshotted at open time.
    /// Zeroed by `expire_position` once removed from `pool.total_weight`.
    pub weight: u128,
    /// When this position's weight stops counting. For Lock, this is also
    /// when the principal becomes withdrawable via `expire_position`. For
    /// Burn, only the weight expires — the tokens were already destroyed
    /// at `open_burn` time.
    pub unlock_at: i64,
    pub reward_debt: u128,
    /// Pending reward "banked" here whenever weight changes (open_lock/
    /// open_burn/expire_position never touch lamports directly — see the
    /// note on `claim_yield` for why). Only `claim_yield` (no token CPI at
    /// all) ever actually moves lamports out of the reward vault.
    pub unclaimed_lamports: u64,
    /// True once `expire_position` has run — weight already removed from
    /// `pool.total_weight` (and, for Lock, principal already returned).
    /// `unclaimed_lamports` may still be nonzero and claimable after this.
    pub expired: bool,
    pub bump: u8,
}

impl Position {
    pub const LEN: usize = 8 + 32 + 8 + 1 + 8 + 16 + 8 + 16 + 8 + 1 + 1;
}

/// Program-owned lamport holder for the XNT staking reward pool — same
/// reasoning as `Vault`: must be program-owned, not a bare System account,
/// so `pay_from_reward_vault` can debit it via direct pointer arithmetic.
#[account]
pub struct RewardVault {
    pub bump: u8,
}

impl RewardVault {
    pub const LEN: usize = 8 + 1;
}

/// Minimal constant-product $MINE/XNT pool. Reserves are just the live
/// balances of `pool_xnt_vault`/`pool_mine_vault` — deliberately no
/// separate ledger fields to keep in sync (a whole class of accounting
/// bugs avoided by not duplicating what's already on-chain truth).
#[account]
pub struct LiquidityPool {
    pub mine_mint: Pubkey,
    pub mine_vault: Pubkey,
    pub xnt_vault_bump: u8,
    pub pool_authority_bump: u8,
    pub bump: u8,
    pub total_xnt_volume: u64,
}

impl LiquidityPool {
    pub const LEN: usize = 8 + 32 * 2 + 1 + 1 + 1 + 8;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub resolver_authority: Pubkey,
    pub treasury_authority: Pubkey,
    pub mine_mint: Pubkey,
    pub house_edge_bps: u16,
    pub min_bet: u64,
    pub max_bet: u64,
}

#[event]
pub struct SeedCommitted {
    pub seed_hash: [u8; 32],
    pub previous_hash: [u8; 32],
    pub nonce: u64,
    pub slot: u64,
}

#[event]
pub struct SeedRevealed {
    pub committed_hash: [u8; 32],
    pub raw_seed: [u8; 32],
    pub slot: u64,
}

#[event]
pub struct RoundStarted {
    pub round: Pubkey,
    pub player: Pubkey,
    pub round_id: u64,
    pub bet_amount: u64,
    pub mine_count: u8,
    pub seed_commitment: [u8; 32],
}

#[event]
pub struct RevealResolved {
    pub round: Pubkey,
    pub round_id: u64,
    pub player: Pubkey,
    pub tile_index: u8,
    pub revealed_count: u8,
    pub multiplier_scaled: u128,
}

#[event]
pub struct RoundBusted {
    pub round: Pubkey,
    pub round_id: u64,
    pub player: Pubkey,
    pub tile_index: u8,
    pub revealed_count: u8,
}

#[event]
pub struct CashedOut {
    pub round: Pubkey,
    pub round_id: u64,
    pub player: Pubkey,
    pub revealed_count: u8,
    pub payout: u64,
    pub mine_minted_player: u64,
    pub mine_minted_leaderboard: u64,
    pub mine_minted_rakeback: u64,
}

#[event]
pub struct BankrollDeposited {
    pub funder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BankrollWithdrawn {
    pub treasury_authority: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PausedSet {
    pub paused: bool,
}

#[event]
pub struct LimitsUpdated {
    pub min_bet: u64,
    pub max_bet: u64,
}

#[event]
pub struct DigConfigInitialized {
    pub tier_prices: [u64; DIG_TIER_COUNT],
    pub tier_durations: [u32; DIG_TIER_COUNT],
    pub active_rarity_count: u8,
}

#[event]
pub struct DigTiersUpdated {
    pub tier_prices: [u64; DIG_TIER_COUNT],
    pub tier_durations: [u32; DIG_TIER_COUNT],
}

#[event]
pub struct RarityTiersUpdated {
    pub active_rarity_count: u8,
}

#[event]
pub struct DigStarted {
    pub session: Pubkey,
    pub player: Pubkey,
    pub session_id: u64,
    pub duration_tier: u8,
    pub bet_amount: u64,
    pub seed_commitment: [u8; 32],
}

#[event]
pub struct DigResolved {
    pub session: Pubkey,
    pub session_id: u64,
    pub player: Pubkey,
    pub rarity_hit: u8,
    pub floor_amount: u64,
    pub bonus_amount: u64,
}

#[event]
pub struct StakingPoolInitialized {
    pub skim_bps: u16,
    pub active_lock_tier_count: u8,
    pub active_burn_tier_count: u8,
}

#[event]
pub struct StakingParamsUpdated {
    pub skim_bps: u16,
}

#[event]
pub struct PositionOpened {
    pub owner: Pubkey,
    pub position_id: u64,
    /// 0 = Lock, 1 = Burn (mirrors PositionKind's discriminant).
    pub kind: u8,
    pub amount: u64,
    pub tier: u8,
    pub weight: u128,
    pub unlock_at: i64,
}

#[event]
pub struct PositionExpired {
    pub owner: Pubkey,
    pub position_id: u64,
    pub kind: u8,
}

#[event]
pub struct YieldClaimed {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct WagerSkimRouted {
    pub amount: u64,
    pub allocated: bool,
}

#[event]
pub struct LiquidityPoolInitialized {
    pub initial_xnt: u64,
    pub initial_mine: u64,
}

#[event]
pub struct SwappedXntForMine {
    pub trader: Pubkey,
    pub xnt_in: u64,
    pub mine_out: u64,
}

#[event]
pub struct SwappedMineForXnt {
    pub trader: Pubkey,
    pub mine_in: u64,
    pub xnt_out: u64,
}

#[event]
pub struct BuybackAndBurned {
    pub xnt_amount: u64,
    pub mine_burned: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum MinesError {
    #[msg("math overflow")]
    MathOverflow,
    #[msg("game is paused")]
    Paused,
    #[msg("mine count out of range")]
    InvalidMineCount,
    #[msg("bet amount out of configured range")]
    BetOutOfRange,
    #[msg("tile index out of range")]
    InvalidTileIndex,
    #[msg("tile was already revealed")]
    TileAlreadyHandled,
    #[msg("round is not active")]
    RoundNotActive,
    #[msg("no safe tiles revealed yet, nothing to cash out")]
    NothingToCashOut,
    #[msg("revealed raw seed does not match its committed hash")]
    SeedMismatch,
    #[msg("no seed has been committed yet")]
    NoSeedCommitted,
    #[msg("invalid instruction parameter")]
    InvalidParam,
    #[msg("bankroll has insufficient balance")]
    InsufficientBankroll,
    #[msg("dig session's duration has not elapsed yet")]
    DigNotFinished,
    #[msg("stake is still within its lockup period")]
    StakeLocked,
    #[msg("cannot fund staking rewards with zero stakers")]
    NoStakers,
    #[msg("liquidity pool has no reserves")]
    PoolEmpty,
    #[msg("swap output is below the requested minimum (slippage)")]
    SlippageExceeded,
    #[msg("position has already been expired/reaped")]
    AlreadyExpired,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Fair (zero-house-edge) hypergeometric multiplier for having safely
/// revealed `revealed` tiles out of `total_tiles` with `mines` mines
/// present, expressed as a fixed-point integer scaled by MULT_SCALE.
fn fair_multiplier_scaled(revealed: u8, mines: u8, total_tiles: u8) -> Result<u128> {
    let mut m: u128 = MULT_SCALE;
    for i in 0..revealed as u128 {
        let n = total_tiles as u128;
        let numerator = n.checked_sub(i).ok_or(MinesError::MathOverflow)?;
        let denominator = numerator.checked_sub(mines as u128).ok_or(MinesError::MathOverflow)?;
        require!(denominator > 0, MinesError::MathOverflow);
        m = m.checked_mul(numerator).ok_or(MinesError::MathOverflow)?.checked_div(denominator).ok_or(MinesError::MathOverflow)?;
    }
    Ok(m)
}

/// Looks up the current $MINE emission rate for the given cumulative wagered
/// volume against the halving schedule in VOLUME_THRESHOLDS.
fn emission_rate_scaled(cumulative_volume: u64) -> u128 {
    for (threshold, rate) in VOLUME_THRESHOLDS.iter() {
        if cumulative_volume < *threshold {
            return *rate;
        }
    }
    VOLUME_THRESHOLDS[VOLUME_THRESHOLDS.len() - 1].1
}

/// Standard MasterChef/Synthetix accumulator-pattern pending-reward calc,
/// denominated per unit of a position's *weight* rather than per raw
/// staked token — this is the whole mechanism behind "lock longer = earn
/// more" and "burn = earn even more, for a while".
fn pending_reward(weight: u128, acc_reward_per_weight: u128, reward_debt: u128) -> Result<u64> {
    let accrued = weight.checked_mul(acc_reward_per_weight).ok_or(MinesError::MathOverflow)?
        .checked_div(ACC_REWARD_SCALE).ok_or(MinesError::MathOverflow)?;
    Ok(accrued.saturating_sub(reward_debt).try_into().unwrap_or(u64::MAX))
}

fn weight_reward_debt(weight: u128, acc_reward_per_weight: u128) -> Result<u128> {
    weight.checked_mul(acc_reward_per_weight).ok_or(MinesError::MathOverflow)?
        .checked_div(ACC_REWARD_SCALE).ok_or(MinesError::MathOverflow.into())
}

/// Sweeps any skim that arrived while `total_weight` was still zero (no
/// one to attribute it to yet) into the accumulator, using the pool's
/// weight as it stood *before* the caller's own stake/burn is applied —
/// critical ordering: if this ran using weight that already includes the
/// position calling it, that position's own reward_debt (set right after,
/// using the post-sweep accumulator) would cancel out its own share of the
/// sweep, and since it'd be the only weight in the "first staker" case,
/// the swept funds would be permanently unclaimable by anyone. Deferring
/// until *some* prior weight exists lets it correctly land on whoever was
/// already staked, exactly like normal accumulator growth would.
fn settle_unallocated(pool: &mut Account<StakingPool>) -> Result<()> {
    if pool.unallocated_rewards > 0 && pool.total_weight > 0 {
        let delta = (pool.unallocated_rewards as u128).checked_mul(ACC_REWARD_SCALE).ok_or(MinesError::MathOverflow)?
            .checked_div(pool.total_weight).ok_or(MinesError::MathOverflow)?;
        pool.acc_reward_per_weight = pool.acc_reward_per_weight.checked_add(delta).ok_or(MinesError::MathOverflow)?;
        pool.unallocated_rewards = 0;
    }
    Ok(())
}

/// Called from `start_round` (Mines only — see `route_wykop_wager` for
/// Wykop's very different split): skims `pool.skim_bps` of the wager
/// straight out of the incoming payment (before it even reaches the main
/// game vault) into the staking reward vault, and routes it into the
/// accumulator immediately if there's weight to attribute it to yet.
/// Returns the skim amount actually taken, so the caller knows how much
/// less reaches the main vault.
fn route_wager_skim<'info>(
    wager: u64,
    payer: &AccountInfo<'info>,
    reward_vault: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    pool: &mut Account<'info, StakingPool>,
) -> Result<u64> {
    let skim = (wager as u128).checked_mul(pool.skim_bps as u128).ok_or(MinesError::MathOverflow)?
        .checked_div(10_000).ok_or(MinesError::MathOverflow)?
        .try_into().map_err(|_| MinesError::MathOverflow)?;
    if skim == 0 {
        return Ok(0);
    }
    if pool.total_weight > 0 {
        invoke(
            &system_instruction::transfer(payer.key, reward_vault.key, skim),
            &[payer.clone(), reward_vault.clone(), system_program.clone()],
        )?;
        let delta = (skim as u128).checked_mul(ACC_REWARD_SCALE).ok_or(MinesError::MathOverflow)?
            .checked_div(pool.total_weight).ok_or(MinesError::MathOverflow)?;
        pool.acc_reward_per_weight = pool.acc_reward_per_weight.checked_add(delta).ok_or(MinesError::MathOverflow)?;
    } else {
        // Nobody is staked right now to legitimately attribute this to.
        // Used to strand it in `unallocated_rewards`, waiting for whoever
        // happened to open the next position to sweep it in and walk away
        // with the whole backlog regardless of how briefly they'd actually
        // been staked (confirmed as a real, reproduced windfall on
        // testnet, 2026-08-04 — the fix here). Routing it straight to the
        // shared vault instead means there's no unclaimed backlog left
        // sitting around for a lucky new staker to capture. On mainnet,
        // with long-running staking participation, total_weight == 0
        // should be rare-to-never anyway, so this mostly matters for
        // testnet's cold-start gaps.
        invoke(
            &system_instruction::transfer(payer.key, vault.key, skim),
            &[payer.clone(), vault.clone(), system_program.clone()],
        )?;
    }
    emit!(WagerSkimRouted { amount: skim, allocated: pool.total_weight > 0 });
    Ok(skim)
}

/// Wykop-only wager split — see the comment on WYKOP_STAKING_BPS for why
/// this looks nothing like Mines' route_wager_skim. resolve_dig never
/// draws XNT back out of the shared vault (it only ever mints $MINE), so
/// unlike Mines' wager, the whole thing is unencumbered revenue with no
/// payout obligation behind it — split four ways: staking (biggest share,
/// meant to make holding/locking $MINE genuinely worthwhile), an
/// automatic buyback-and-burn swap (so deflation is a guaranteed side
/// effect of playing, not a manual admin task someone has to remember to
/// run), a straight top-up of the liquidity pool's XNT reserve (directly
/// deepens what Wykop's own price-aware floor depends on), and whatever's
/// left to the shared vault (a small ecosystem-health contribution, not a
/// subsidy Wykop owes Mines). Confirmed split with the user 2026-08-04.
fn route_wykop_wager<'info>(
    wager: u64,
    player: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    reward_vault: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    pool_xnt_vault: &AccountInfo<'info>,
    pool_mine_vault: &AccountInfo<'info>,
    pool_mine_vault_amount: u64,
    mine_mint: &AccountInfo<'info>,
    pool_authority: &AccountInfo<'info>,
    pool_authority_bump: u8,
    token_program: &AccountInfo<'info>,
    staking_pool: &mut Account<'info, StakingPool>,
) -> Result<()> {
    let staking_amt: u64 = (wager as u128)
        .checked_mul(WYKOP_STAKING_BPS as u128).ok_or(MinesError::MathOverflow)?
        .checked_div(10_000).ok_or(MinesError::MathOverflow)?
        .try_into().map_err(|_| MinesError::MathOverflow)?;
    let buyback_amt: u64 = (wager as u128)
        .checked_mul(WYKOP_BUYBACK_BPS as u128).ok_or(MinesError::MathOverflow)?
        .checked_div(10_000).ok_or(MinesError::MathOverflow)?
        .try_into().map_err(|_| MinesError::MathOverflow)?;
    let liquidity_amt: u64 = (wager as u128)
        .checked_mul(WYKOP_LIQUIDITY_BPS as u128).ok_or(MinesError::MathOverflow)?
        .checked_div(10_000).ok_or(MinesError::MathOverflow)?
        .try_into().map_err(|_| MinesError::MathOverflow)?;
    // Remainder, not a fourth percentage of its own — avoids rounding
    // dust from three separate bps divisions silently vanishing.
    let vault_amt = wager
        .checked_sub(staking_amt).ok_or(MinesError::MathOverflow)?
        .checked_sub(buyback_amt).ok_or(MinesError::MathOverflow)?
        .checked_sub(liquidity_amt).ok_or(MinesError::MathOverflow)?;

    // --- staking: same accumulator-routing logic as route_wager_skim,
    // including routing to the shared vault instead of stranding in
    // unallocated_rewards when nobody's currently staked (see the comment
    // there for why). ---
    if staking_amt > 0 {
        if staking_pool.total_weight > 0 {
            invoke(
                &system_instruction::transfer(player.key, reward_vault.key, staking_amt),
                &[player.clone(), reward_vault.clone(), system_program.clone()],
            )?;
            let delta = (staking_amt as u128).checked_mul(ACC_REWARD_SCALE).ok_or(MinesError::MathOverflow)?
                .checked_div(staking_pool.total_weight).ok_or(MinesError::MathOverflow)?;
            staking_pool.acc_reward_per_weight =
                staking_pool.acc_reward_per_weight.checked_add(delta).ok_or(MinesError::MathOverflow)?;
        } else {
            invoke(
                &system_instruction::transfer(player.key, vault.key, staking_amt),
                &[player.clone(), vault.clone(), system_program.clone()],
            )?;
        }
        emit!(WagerSkimRouted { amount: staking_amt, allocated: staking_pool.total_weight > 0 });
    }

    // --- automatic buyback & burn, priced off reserves as they stand right
    // now (before this same call's liquidity top-up below lands) — same
    // quoting/guard logic as the manual buyback_and_burn instruction. Falls
    // back to a plain liquidity deposit if the pool can't be safely quoted
    // right now, so this slice of the wager is never silently dropped. ---
    if buyback_amt > 0 {
        let reserve_xnt = pool_xnt_vault.lamports();
        let mine_out = if reserve_xnt > 0 && pool_mine_vault_amount > 0 {
            constant_product_out(buyback_amt, reserve_xnt, pool_mine_vault_amount).unwrap_or(0)
        } else {
            0
        };
        invoke(
            &system_instruction::transfer(player.key, pool_xnt_vault.key, buyback_amt),
            &[player.clone(), pool_xnt_vault.clone(), system_program.clone()],
        )?;
        if mine_out > 0 && mine_out < pool_mine_vault_amount {
            let seeds: &[&[u8]] = &[POOL_AUTHORITY_SEED, &[pool_authority_bump]];
            let signer = &[seeds];
            token::burn(
                CpiContext::new_with_signer(
                    token_program.clone(),
                    token::Burn {
                        mint: mine_mint.clone(),
                        from: pool_mine_vault.clone(),
                        authority: pool_authority.clone(),
                    },
                    signer,
                ),
                mine_out,
            )?;
            emit!(BuybackAndBurned { xnt_amount: buyback_amt, mine_burned: mine_out });
        }
    }

    // --- straight liquidity top-up, no swap ---
    if liquidity_amt > 0 {
        invoke(
            &system_instruction::transfer(player.key, pool_xnt_vault.key, liquidity_amt),
            &[player.clone(), pool_xnt_vault.clone(), system_program.clone()],
        )?;
    }

    // --- remainder to the shared vault ---
    if vault_amt > 0 {
        invoke(
            &system_instruction::transfer(player.key, vault.key, vault_amt),
            &[player.clone(), vault.clone(), system_program.clone()],
        )?;
    }

    Ok(())
}

/// Both `reward_vault` and the recipient are plain system accounts (or a
/// program-owned lamport holder in the vault's case) — direct pointer
/// arithmetic works the same way it does for the main game vault.
fn pay_from_reward_vault(reward_vault: &AccountInfo, recipient: &AccountInfo, amount: u64) -> Result<()> {
    **reward_vault.try_borrow_mut_lamports()? -= amount;
    **recipient.try_borrow_mut_lamports()? += amount;
    Ok(())
}

/// Standard constant-product (x*y=k) swap-output formula with a fee taken
/// off the input side. Used symmetrically for both swap directions — the
/// caller passes whichever reserve is "in" vs "out".
fn constant_product_out(amount_in: u64, reserve_in: u64, reserve_out: u64) -> Result<u64> {
    let amount_in_with_fee = (amount_in as u128)
        .checked_mul(10_000u128.checked_sub(SWAP_FEE_BPS as u128).ok_or(MinesError::MathOverflow)?)
        .ok_or(MinesError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(MinesError::MathOverflow)?;
    let numerator = (reserve_out as u128).checked_mul(amount_in_with_fee).ok_or(MinesError::MathOverflow)?;
    let denominator = (reserve_in as u128).checked_add(amount_in_with_fee).ok_or(MinesError::MathOverflow)?;
    require!(denominator > 0, MinesError::MathOverflow);
    (numerator / denominator).try_into().map_err(|_| MinesError::MathOverflow.into())
}

/// Reads the pool's live reserves and returns how many raw $MINE units are
/// currently worth `xnt_value_lamports` at spot price — a pure read, no
/// trade executed. This is what makes Wykop's floor price-aware (see
/// resolve_dig): the target XNT *value* stays roughly constant as $MINE's
/// market price moves, instead of the raw token count staying constant
/// while its real value drifts with the price.
fn mine_amount_for_xnt_value(xnt_value_lamports: u128, reserve_xnt: u64, reserve_mine: u64) -> Result<u64> {
    if reserve_xnt == 0 || reserve_mine == 0 {
        return Ok(0);
    }
    xnt_value_lamports
        .checked_mul(reserve_mine as u128)
        .ok_or(MinesError::MathOverflow)?
        .checked_div(reserve_xnt as u128)
        .ok_or(MinesError::MathOverflow)?
        .try_into()
        .map_err(|_| MinesError::MathOverflow.into())
}
