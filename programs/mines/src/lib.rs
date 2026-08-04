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
pub const STAKING_POOL_SEED: &[u8] = b"staking_pool";
pub const STAKE_POSITION_SEED: &[u8] = b"stake_position";
pub const STAKE_TOKEN_VAULT_SEED: &[u8] = b"stake_token_vault";
pub const STAKING_AUTHORITY_SEED: &[u8] = b"staking_authority";
pub const REWARD_VAULT_SEED: &[u8] = b"reward_vault";

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

        // Move the bet from player -> vault (native lamports).
        invoke(
            &system_instruction::transfer(&ctx.accounts.player.key(), &ctx.accounts.vault.key(), bet_amount),
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

        invoke(
            &system_instruction::transfer(&ctx.accounts.player.key(), &ctx.accounts.vault.key(), price),
            &[
                ctx.accounts.player.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
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
        let floor_amount: u64 = ((session.bet_amount as u128)
            .checked_mul(rate)
            .ok_or(MinesError::MathOverflow)?
            .checked_div(EMISSION_SCALE)
            .ok_or(MinesError::MathOverflow)?)
        .try_into()
        .map_err(|_| MinesError::MathOverflow)?;

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
    // $MINE staking — real XNT yield, funded from platform revenue
    // (`fund_staking_rewards`, admin/treasury-operated), not from token
    // emission. Rewards are a pro-rata share of whatever XNT actually
    // arrived (Synthetix/MasterChef accumulator pattern) — deliberately
    // *not* a fixed or promised rate. A fixed floor-token payout combined
    // with a fixed yield rate would be a risk-free arbitrage (buy the
    // floor, stake it, yield more than you paid); making the return
    // genuinely unknowable in advance and dependent on total participation
    // closes that off without needing a $MINE/XNT price oracle at all.
    // -----------------------------------------------------------------

    pub fn initialize_staking_pool(ctx: Context<InitializeStakingPool>, stake_lockup_seconds: u32) -> Result<()> {
        let pool = &mut ctx.accounts.staking_pool;
        pool.admin = ctx.accounts.admin.key();
        pool.mine_mint = ctx.accounts.config.mine_mint;
        pool.stake_token_vault = ctx.accounts.stake_token_vault.key();
        pool.total_staked = 0;
        pool.acc_reward_per_share = 0;
        pool.stake_lockup_seconds = stake_lockup_seconds;
        pool.bump = ctx.bumps["staking_pool"];
        pool.reward_vault_bump = ctx.bumps["reward_vault"];
        pool.staking_authority_bump = ctx.bumps["staking_authority"];
        ctx.accounts.reward_vault.bump = ctx.bumps["reward_vault"];

        emit!(StakingPoolInitialized { stake_lockup_seconds });
        Ok(())
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, MinesError::InvalidParam);

        let pool = &mut ctx.accounts.staking_pool;
        let position = &mut ctx.accounts.position;

        if position.staked_amount > 0 {
            let pending = pending_reward(position.staked_amount, pool.acc_reward_per_share, position.reward_debt)?;
            if pending > 0 {
                pay_from_reward_vault(
                    &ctx.accounts.reward_vault.to_account_info(),
                    &ctx.accounts.staker.to_account_info(),
                    pending,
                )?;
            }
        } else {
            position.owner = ctx.accounts.staker.key();
            position.bump = ctx.bumps["position"];
        }

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

        pool.total_staked = pool.total_staked.checked_add(amount).ok_or(MinesError::MathOverflow)?;
        position.staked_amount = position.staked_amount.checked_add(amount).ok_or(MinesError::MathOverflow)?;
        position.reward_debt = (position.staked_amount as u128)
            .checked_mul(pool.acc_reward_per_share)
            .ok_or(MinesError::MathOverflow)?
            .checked_div(ACC_REWARD_SCALE)
            .ok_or(MinesError::MathOverflow)?;
        // Resets on every top-up, not just the first stake — otherwise
        // topping up by a trivial amount would be a way to dodge most of
        // the lockup on a much larger pre-existing position.
        position.staked_at = Clock::get()?.unix_timestamp;

        emit!(Staked { owner: position.owner, amount, total_staked: position.staked_amount });
        Ok(())
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        let pool = &mut ctx.accounts.staking_pool;
        let position = &mut ctx.accounts.position;

        require!(amount > 0 && amount <= position.staked_amount, MinesError::InvalidParam);
        let elapsed = Clock::get()?.unix_timestamp - position.staked_at;
        require!(elapsed >= pool.stake_lockup_seconds as i64, MinesError::StakeLocked);

        let pending = pending_reward(position.staked_amount, pool.acc_reward_per_share, position.reward_debt)?;
        if pending > 0 {
            pay_from_reward_vault(
                &ctx.accounts.reward_vault.to_account_info(),
                &ctx.accounts.staker.to_account_info(),
                pending,
            )?;
        }

        let seeds: &[&[u8]] = &[STAKING_AUTHORITY_SEED, &[pool.staking_authority_bump]];
        let signer = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.stake_token_vault.to_account_info(),
                    to: ctx.accounts.staker_mine_ata.to_account_info(),
                    authority: ctx.accounts.staking_authority.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        pool.total_staked = pool.total_staked.checked_sub(amount).ok_or(MinesError::MathOverflow)?;
        position.staked_amount = position.staked_amount.checked_sub(amount).ok_or(MinesError::MathOverflow)?;
        position.reward_debt = (position.staked_amount as u128)
            .checked_mul(pool.acc_reward_per_share)
            .ok_or(MinesError::MathOverflow)?
            .checked_div(ACC_REWARD_SCALE)
            .ok_or(MinesError::MathOverflow)?;

        emit!(Unstaked { owner: position.owner, amount, total_staked: position.staked_amount });
        Ok(())
    }

    pub fn claim_yield(ctx: Context<ClaimYield>) -> Result<()> {
        let pool = &ctx.accounts.staking_pool;
        let position = &mut ctx.accounts.position;

        let pending = pending_reward(position.staked_amount, pool.acc_reward_per_share, position.reward_debt)?;
        require!(pending > 0, MinesError::NothingToCashOut);

        pay_from_reward_vault(&ctx.accounts.reward_vault.to_account_info(), &ctx.accounts.staker.to_account_info(), pending)?;

        position.reward_debt = (position.staked_amount as u128)
            .checked_mul(pool.acc_reward_per_share)
            .ok_or(MinesError::MathOverflow)?
            .checked_div(ACC_REWARD_SCALE)
            .ok_or(MinesError::MathOverflow)?;

        emit!(YieldClaimed { owner: position.owner, amount: pending });
        Ok(())
    }

    /// Admin/treasury-operated: moves accumulated house revenue that's
    /// otherwise just sitting in the shared `vault` into the staking reward
    /// pool, and bumps the accumulator so existing stakers can claim their
    /// pro-rata share. Requires at least one staker — funding with zero
    /// stakers would permanently strand the lamports (no one's
    /// `acc_reward_per_share` delta could ever account for them).
    pub fn fund_staking_rewards(ctx: Context<FundStakingRewards>, amount: u64) -> Result<()> {
        require!(amount > 0, MinesError::InvalidParam);
        let pool = &mut ctx.accounts.staking_pool;
        require!(pool.total_staked > 0, MinesError::NoStakers);
        require!(ctx.accounts.vault.to_account_info().lamports() >= amount, MinesError::InsufficientBankroll);

        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.reward_vault.to_account_info().try_borrow_mut_lamports()? += amount;

        let delta = (amount as u128).checked_mul(ACC_REWARD_SCALE).ok_or(MinesError::MathOverflow)?
            .checked_div(pool.total_staked as u128).ok_or(MinesError::MathOverflow)?;
        pool.acc_reward_per_share = pool.acc_reward_per_share.checked_add(delta).ok_or(MinesError::MathOverflow)?;

        emit!(StakingRewardsFunded { amount, new_acc_reward_per_share: pool.acc_reward_per_share });
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
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = player,
        space = Round::LEN,
        seeds = [ROUND_SEED, &config.total_rounds.to_le_bytes()],
        bump
    )]
    pub round: Account<'info, Round>,

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
pub struct Stake<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(mut, seeds = [STAKING_POOL_SEED], bump = staking_pool.bump)]
    pub staking_pool: Box<Account<'info, StakingPool>>,

    #[account(
        init_if_needed,
        payer = staker,
        space = StakePosition::LEN,
        seeds = [STAKE_POSITION_SEED, staker.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, StakePosition>>,

    #[account(mut, seeds = [REWARD_VAULT_SEED], bump = staking_pool.reward_vault_bump)]
    pub reward_vault: Box<Account<'info, RewardVault>>,

    #[account(mut, address = staking_pool.stake_token_vault)]
    pub stake_token_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, associated_token::mint = staking_pool.mine_mint, associated_token::authority = staker)]
    pub staker_mine_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(mut, seeds = [STAKING_POOL_SEED], bump = staking_pool.bump)]
    pub staking_pool: Box<Account<'info, StakingPool>>,

    #[account(mut, seeds = [STAKE_POSITION_SEED, staker.key().as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, StakePosition>>,

    #[account(mut, seeds = [REWARD_VAULT_SEED], bump = staking_pool.reward_vault_bump)]
    pub reward_vault: Box<Account<'info, RewardVault>>,

    #[account(mut, address = staking_pool.stake_token_vault)]
    pub stake_token_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: signer-only PDA, see InitializeStakingPool.
    #[account(seeds = [STAKING_AUTHORITY_SEED], bump = staking_pool.staking_authority_bump)]
    pub staking_authority: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = staking_pool.mine_mint, associated_token::authority = staker)]
    pub staker_mine_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimYield<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(seeds = [STAKING_POOL_SEED], bump = staking_pool.bump)]
    pub staking_pool: Box<Account<'info, StakingPool>>,

    #[account(mut, seeds = [STAKE_POSITION_SEED, staker.key().as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, StakePosition>>,

    #[account(mut, seeds = [REWARD_VAULT_SEED], bump = staking_pool.reward_vault_bump)]
    pub reward_vault: Box<Account<'info, RewardVault>>,
}

#[derive(Accounts)]
pub struct FundStakingRewards<'info> {
    #[account(mut)]
    pub treasury_authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = treasury_authority)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(mut, seeds = [STAKING_POOL_SEED], bump = staking_pool.bump)]
    pub staking_pool: Box<Account<'info, StakingPool>>,

    #[account(mut, seeds = [REWARD_VAULT_SEED], bump = staking_pool.reward_vault_bump)]
    pub reward_vault: Box<Account<'info, RewardVault>>,
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
    pub total_staked: u64,
    pub acc_reward_per_share: u128,
    pub stake_lockup_seconds: u32,
    pub bump: u8,
    pub reward_vault_bump: u8,
    pub staking_authority_bump: u8,
}

impl StakingPool {
    pub const LEN: usize = 8 + 32 * 3 + 8 + 16 + 4 + 1 + 1 + 1;
}

#[account]
pub struct StakePosition {
    pub owner: Pubkey,
    pub staked_amount: u64,
    pub reward_debt: u128,
    pub staked_at: i64,
    pub bump: u8,
}

impl StakePosition {
    pub const LEN: usize = 8 + 32 + 8 + 16 + 8 + 1;
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
    pub stake_lockup_seconds: u32,
}

#[event]
pub struct Staked {
    pub owner: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

#[event]
pub struct Unstaked {
    pub owner: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

#[event]
pub struct YieldClaimed {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct StakingRewardsFunded {
    pub amount: u64,
    pub new_acc_reward_per_share: u128,
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

/// Standard MasterChef/Synthetix accumulator-pattern pending-reward calc.
fn pending_reward(staked_amount: u64, acc_reward_per_share: u128, reward_debt: u128) -> Result<u64> {
    let accrued = (staked_amount as u128)
        .checked_mul(acc_reward_per_share)
        .ok_or(MinesError::MathOverflow)?
        .checked_div(ACC_REWARD_SCALE)
        .ok_or(MinesError::MathOverflow)?;
    Ok(accrued.saturating_sub(reward_debt).try_into().unwrap_or(u64::MAX))
}

/// Both `reward_vault` and the recipient are plain system accounts (or a
/// program-owned lamport holder in the vault's case) — direct pointer
/// arithmetic works the same way it does for the main game vault.
fn pay_from_reward_vault(reward_vault: &AccountInfo, recipient: &AccountInfo, amount: u64) -> Result<()> {
    **reward_vault.try_borrow_mut_lamports()? -= amount;
    **recipient.try_borrow_mut_lamports()? += amount;
    Ok(())
}
