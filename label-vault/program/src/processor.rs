use crate::{
    error::VaultError,
    instruction::{find_vault_authority_address, find_vault_config_address, VaultInstruction, VAULT_AUTHORITY_SEED, VAULT_CONFIG_SEED},
    state::{Allocation, VaultConfig, MAX_ALLOCATIONS, MAX_NAME_LEN, MAX_SYMBOL_LEN, REBALANCE_WINNER_WEIGHT_BPS},
};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};
use spl_stake_pool::state::StakePool;

type AllocAccounts<'a> = (
    AccountInfo<'a>,
    AccountInfo<'a>,
    AccountInfo<'a>,
    AccountInfo<'a>,
    AccountInfo<'a>,
    AccountInfo<'a>,
    AccountInfo<'a>,
);

pub struct Processor;

impl Processor {
    pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], input: &[u8]) -> ProgramResult {
        let instruction = VaultInstruction::try_from_slice(input)
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        match instruction {
            VaultInstruction::CreateLabel {
                name,
                symbol,
                weights_bps,
            } => Self::process_create_label(program_id, accounts, name, symbol, weights_bps),
            VaultInstruction::Deposit { lamports_in } => {
                Self::process_deposit(program_id, accounts, lamports_in)
            }
            VaultInstruction::Withdraw { label_tokens_in } => {
                Self::process_withdraw(program_id, accounts, label_tokens_in)
            }
            VaultInstruction::Rebalance => Self::process_rebalance(program_id, accounts),
        }
    }

    #[inline(never)]
    fn process_create_label(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        name: [u8; MAX_NAME_LEN],
        symbol: [u8; MAX_SYMBOL_LEN],
        weights_bps: Vec<u16>,
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let payer_info = next_account_info(account_info_iter)?;
        let vault_config_info = next_account_info(account_info_iter)?;
        let vault_authority_info = next_account_info(account_info_iter)?;
        let label_mint_info = next_account_info(account_info_iter)?;
        let system_program_info = next_account_info(account_info_iter)?;

        if !payer_info.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        let allocation_count = weights_bps.len();
        if allocation_count == 0 || allocation_count > MAX_ALLOCATIONS {
            return Err(VaultError::TooManyAllocations.into());
        }
        let weight_sum: u32 = weights_bps.iter().map(|w| *w as u32).sum();
        if weight_sum != 10_000 {
            msg!("Weights sum to {}, expected 10000", weight_sum);
            return Err(VaultError::InvalidWeights.into());
        }

        let (expected_vault_config, _config_bump) =
            find_vault_config_address(program_id, label_mint_info.key);
        if expected_vault_config != *vault_config_info.key {
            return Err(VaultError::InvalidVaultConfig.into());
        }
        let (expected_vault_authority, vault_authority_bump) =
            find_vault_authority_address(program_id, label_mint_info.key);
        if expected_vault_authority != *vault_authority_info.key {
            return Err(VaultError::InvalidVaultAuthority.into());
        }

        if vault_config_info.data_len() > 0 {
            return Err(VaultError::AlreadyInitialized.into());
        }

        let mut allocations = [Allocation::default(); MAX_ALLOCATIONS];
        for (i, weight_bps) in weights_bps.iter().enumerate() {
            let pool_info = next_account_info(account_info_iter)?;
            let vault_token_info = next_account_info(account_info_iter)?;
            allocations[i] = Self::read_allocation(pool_info, vault_token_info, vault_authority_info.key, *weight_bps)?;
        }

        let vault_config = VaultConfig {
            is_initialized: true,
            creator: *payer_info.key,
            label_mint: *label_mint_info.key,
            vault_authority_bump,
            allocation_count: allocation_count as u8,
            name,
            symbol,
            allocations,
        };

        let rent = Rent::get()?;
        let space = VaultConfig::LEN as u64;
        let lamports = rent.minimum_balance(space as usize);
        invoke_signed(
            &system_instruction::create_account(
                payer_info.key,
                vault_config_info.key,
                lamports,
                space,
                program_id,
            ),
            &[
                payer_info.clone(),
                vault_config_info.clone(),
                system_program_info.clone(),
            ],
            &[&[
                VAULT_CONFIG_SEED,
                label_mint_info.key.as_ref(),
                &[_config_bump],
            ]],
        )?;

        vault_config.serialize(&mut &mut vault_config_info.data.borrow_mut()[..])?;
        msg!(
            "Created label {} ({}), mint {}, {} allocations",
            vault_config.name_str(),
            vault_config.symbol_str(),
            label_mint_info.key,
            allocation_count
        );
        Ok(())
    }

    #[inline(never)]
    fn process_deposit(program_id: &Pubkey, accounts: &[AccountInfo], lamports_in: u64) -> ProgramResult {
        if lamports_in == 0 {
            return Err(VaultError::ZeroDeposit.into());
        }

        let account_info_iter = &mut accounts.iter();
        let depositor_info = next_account_info(account_info_iter)?;
        let vault_config_info = next_account_info(account_info_iter)?;
        let vault_authority_info = next_account_info(account_info_iter)?;
        let label_mint_info = next_account_info(account_info_iter)?;
        let depositor_label_token_info = next_account_info(account_info_iter)?;
        let token_program_info = next_account_info(account_info_iter)?;
        let system_program_info = next_account_info(account_info_iter)?;

        if !depositor_info.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        let vault_config = Self::load_vault_config(
            program_id,
            vault_config_info,
            vault_authority_info,
            label_mint_info,
        )?;

        let allocations = vault_config.active_allocations();
        let remaining = account_info_iter.as_slice();
        let (allocation_accounts, nav_before) = Self::deposit_scan_allocations(allocations, remaining)?;

        let label_supply_before = {
            let mint = spl_token::state::Mint::unpack(&label_mint_info.data.borrow())
                .map_err(|_| VaultError::AllocationMismatch)?;
            mint.supply
        };

        // Move the deposited XNT into the vault authority PDA, which will act as
        // the `lamports_from` signer for each underlying pool's DepositSol CPI.
        invoke(
            &system_instruction::transfer(depositor_info.key, vault_authority_info.key, lamports_in),
            &[
                depositor_info.clone(),
                vault_authority_info.clone(),
                system_program_info.clone(),
            ],
        )?;

        let authority_seeds: &[&[u8]] = &[
            VAULT_AUTHORITY_SEED,
            label_mint_info.key.as_ref(),
            &[vault_config.vault_authority_bump],
        ];

        let n = allocations.len() as u64;
        for (i, expected) in allocations.iter().enumerate() {
            let amount = if i as u64 == n - 1 {
                // last allocation absorbs rounding dust
                lamports_in
                    - allocations[..i]
                        .iter()
                        .map(|a| lamports_in * a.weight_bps as u64 / 10_000)
                        .sum::<u64>()
            } else {
                lamports_in * expected.weight_bps as u64 / 10_000
            };
            if amount == 0 {
                continue;
            }

            Self::cpi_deposit_sol(
                &allocation_accounts[i],
                vault_authority_info,
                system_program_info,
                token_program_info,
                authority_seeds,
                amount,
            )?;
        }

        let label_tokens_to_mint: u64 = if label_supply_before == 0 || nav_before == 0 {
            lamports_in
        } else {
            u64::try_from(
                (lamports_in as u128)
                    .checked_mul(label_supply_before as u128)
                    .and_then(|v| v.checked_div(nav_before))
                    .ok_or(VaultError::CalculationFailure)?,
            )
            .map_err(|_| VaultError::CalculationFailure)?
        };

        invoke_signed(
            &spl_token::instruction::mint_to(
                token_program_info.key,
                label_mint_info.key,
                depositor_label_token_info.key,
                vault_authority_info.key,
                &[],
                label_tokens_to_mint,
            )?,
            &[
                label_mint_info.clone(),
                depositor_label_token_info.clone(),
                vault_authority_info.clone(),
                token_program_info.clone(),
            ],
            &[authority_seeds],
        )?;

        msg!(
            "Deposited {} lamports, minted {} label tokens (NAV before: {})",
            lamports_in,
            label_tokens_to_mint,
            nav_before
        );
        Ok(())
    }

    #[inline(never)]
    fn process_withdraw(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        label_tokens_in: u64,
    ) -> ProgramResult {
        if label_tokens_in == 0 {
            return Err(VaultError::ZeroWithdraw.into());
        }

        let account_info_iter = &mut accounts.iter();
        let withdrawer_info = next_account_info(account_info_iter)?;
        let vault_config_info = next_account_info(account_info_iter)?;
        let vault_authority_info = next_account_info(account_info_iter)?;
        let label_mint_info = next_account_info(account_info_iter)?;
        let withdrawer_label_token_info = next_account_info(account_info_iter)?;
        let token_program_info = next_account_info(account_info_iter)?;
        let _clock_info = next_account_info(account_info_iter)?;
        let _stake_history_info = next_account_info(account_info_iter)?;
        let _stake_program_info = next_account_info(account_info_iter)?;

        if !withdrawer_info.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        let vault_config = Self::load_vault_config(
            program_id,
            vault_config_info,
            vault_authority_info,
            label_mint_info,
        )?;

        let label_supply_before = {
            let mint = spl_token::state::Mint::unpack(&label_mint_info.data.borrow())
                .map_err(|_| VaultError::AllocationMismatch)?;
            mint.supply
        };
        if label_tokens_in > label_supply_before {
            return Err(VaultError::CalculationFailure.into());
        }

        let allocations = vault_config.active_allocations();
        let authority_seeds: &[&[u8]] = &[
            VAULT_AUTHORITY_SEED,
            label_mint_info.key.as_ref(),
            &[vault_config.vault_authority_bump],
        ];

        // Burn first, using the pre-burn supply for the proportional share below.
        invoke(
            &spl_token::instruction::burn(
                token_program_info.key,
                withdrawer_label_token_info.key,
                label_mint_info.key,
                withdrawer_info.key,
                &[],
                label_tokens_in,
            )?,
            &[
                withdrawer_label_token_info.clone(),
                label_mint_info.clone(),
                withdrawer_info.clone(),
                token_program_info.clone(),
            ],
        )?;

        for expected in allocations {
            let pool_program_info = next_account_info(account_info_iter)?;
            let pool_info = next_account_info(account_info_iter)?;
            let pool_withdraw_authority_info = next_account_info(account_info_iter)?;
            let reserve_stake_info = next_account_info(account_info_iter)?;
            let vault_token_info = next_account_info(account_info_iter)?;
            let manager_fee_info = next_account_info(account_info_iter)?;
            let pool_mint_info = next_account_info(account_info_iter)?;
            let withdrawer_wallet_info = next_account_info(account_info_iter)?;

            Self::check_allocation_accounts(
                expected,
                pool_program_info,
                pool_info,
                pool_withdraw_authority_info,
                reserve_stake_info,
                vault_token_info,
                manager_fee_info,
                pool_mint_info,
            )?;
            if withdrawer_wallet_info.key != withdrawer_info.key {
                return Err(VaultError::AllocationMismatch.into());
            }

            let pool_tokens_out =
                Self::withdraw_share(vault_token_info, label_tokens_in, label_supply_before)?;
            if pool_tokens_out == 0 {
                continue;
            }

            Self::cpi_withdraw_sol(
                pool_program_info,
                pool_info,
                pool_withdraw_authority_info,
                reserve_stake_info,
                vault_token_info,
                manager_fee_info,
                pool_mint_info,
                withdrawer_wallet_info,
                vault_authority_info,
                token_program_info,
                _clock_info,
                _stake_history_info,
                _stake_program_info,
                authority_seeds,
                pool_tokens_out,
            )?;
        }

        msg!(
            "Burned {} label tokens, withdrew proportional share from {} allocations",
            label_tokens_in,
            allocations.len()
        );
        Ok(())
    }

    /// Operator-only. Chases last-epoch yield: the best-performing allocation
    /// gets `REBALANCE_WINNER_WEIGHT_BPS`, the rest split the remainder
    /// proportionally to their own (non-negative) yield. Actually moves
    /// capital to match — not just future deposits.
    #[inline(never)]
    fn process_rebalance(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let creator_info = next_account_info(account_info_iter)?;
        let vault_config_info = next_account_info(account_info_iter)?;
        let vault_authority_info = next_account_info(account_info_iter)?;
        let token_program_info = next_account_info(account_info_iter)?;
        let system_program_info = next_account_info(account_info_iter)?;
        let clock_info = next_account_info(account_info_iter)?;
        let stake_history_info = next_account_info(account_info_iter)?;
        let stake_program_info = next_account_info(account_info_iter)?;

        if !creator_info.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        let mut vault_config =
            Self::load_vault_config_for_rebalance(program_id, vault_config_info, vault_authority_info)?;
        if vault_config.creator != *creator_info.key {
            return Err(VaultError::NotCreator.into());
        }

        let n = vault_config.allocation_count as usize;
        let remaining = account_info_iter.as_slice();

        let (yields, values, rate_num, rate_den) =
            Self::rebalance_gather_snapshots(&vault_config, remaining, n)?;

        let new_weights = Self::rebalance_compute_weights(&yields, n);
        let total_value: u128 = values[..n].iter().sum();

        let authority_seeds: &[&[u8]] = &[
            VAULT_AUTHORITY_SEED,
            vault_config.label_mint.as_ref(),
            &[vault_config.vault_authority_bump],
        ];

        Self::rebalance_withdraw_excess(
            remaining,
            n,
            &values,
            &rate_num,
            &rate_den,
            &new_weights,
            total_value,
            vault_authority_info,
            token_program_info,
            clock_info,
            stake_history_info,
            stake_program_info,
            authority_seeds,
        )?;

        Self::rebalance_deposit_surplus(
            remaining,
            n,
            &values,
            &new_weights,
            total_value,
            vault_authority_info,
            system_program_info,
            token_program_info,
            authority_seeds,
        )?;

        for i in 0..n {
            vault_config.allocations[i].weight_bps = new_weights[i];
        }
        vault_config.serialize(&mut &mut vault_config_info.data.borrow_mut()[..])?;

        msg!("Rebalanced label {}", vault_config_info.key);
        Ok(())
    }

    #[inline(never)]
    fn load_vault_config_for_rebalance(
        program_id: &Pubkey,
        vault_config_info: &AccountInfo,
        vault_authority_info: &AccountInfo,
    ) -> Result<VaultConfig, ProgramError> {
        let vault_config =
            solana_program::borsh0_10::try_from_slice_unchecked::<VaultConfig>(&vault_config_info.data.borrow())
                .map_err(|_| VaultError::NotInitialized)?;
        if !vault_config.is_initialized {
            return Err(VaultError::NotInitialized.into());
        }
        let (expected_vault_config, _) =
            find_vault_config_address(program_id, &vault_config.label_mint);
        if expected_vault_config != *vault_config_info.key {
            return Err(VaultError::InvalidVaultConfig.into());
        }
        let (expected_vault_authority, _) =
            find_vault_authority_address(program_id, &vault_config.label_mint);
        if expected_vault_authority != *vault_authority_info.key {
            return Err(VaultError::InvalidVaultAuthority.into());
        }
        Ok(vault_config)
    }

    /// Reads each allocation's current + last-epoch exchange rate and this
    /// vault's current holding, returning only small fixed arrays — never
    /// keeps a whole `StakePool` alive outside its own frame.
    #[inline(never)]
    #[allow(clippy::type_complexity)]
    fn rebalance_gather_snapshots(
        vault_config: &VaultConfig,
        remaining: &[AccountInfo],
        n: usize,
    ) -> Result<
        (
            [i64; MAX_ALLOCATIONS],
            [u128; MAX_ALLOCATIONS],
            [u128; MAX_ALLOCATIONS],
            [u128; MAX_ALLOCATIONS],
        ),
        ProgramError,
    > {
        let mut yields = [0i64; MAX_ALLOCATIONS];
        let mut values = [0u128; MAX_ALLOCATIONS];
        let mut rate_num = [0u128; MAX_ALLOCATIONS];
        let mut rate_den = [0u128; MAX_ALLOCATIONS];

        for i in 0..n {
            let base = i * 7;
            let pool_program_info = &remaining[base];
            let pool_info = &remaining[base + 1];
            let pool_withdraw_authority_info = &remaining[base + 2];
            let reserve_stake_info = &remaining[base + 3];
            let vault_token_info = &remaining[base + 4];
            let manager_fee_info = &remaining[base + 5];
            let pool_mint_info = &remaining[base + 6];

            Self::check_allocation_accounts(
                &vault_config.allocations[i],
                pool_program_info,
                pool_info,
                pool_withdraw_authority_info,
                reserve_stake_info,
                vault_token_info,
                manager_fee_info,
                pool_mint_info,
            )?;

            let (yield_bps, value, num, den) = Self::read_rebalance_snapshot(pool_info, vault_token_info)?;
            yields[i] = yield_bps;
            values[i] = value;
            rate_num[i] = num;
            rate_den[i] = den;
        }

        Ok((yields, values, rate_num, rate_den))
    }

    #[inline(never)]
    fn read_rebalance_snapshot(
        pool_info: &AccountInfo,
        vault_token_info: &AccountInfo,
    ) -> Result<(i64, u128, u128, u128), ProgramError> {
        let stake_pool =
            solana_program::borsh0_10::try_from_slice_unchecked::<StakePool>(&pool_info.data.borrow())
                .map_err(|_| VaultError::InvalidUnderlyingPool)?;
        let current_num = stake_pool.total_lamports as u128;
        let current_den = (stake_pool.pool_token_supply as u128).max(1);
        let prev_num = stake_pool.last_epoch_total_lamports as u128;
        let prev_den = (stake_pool.last_epoch_pool_token_supply as u128).max(1);

        let yield_bps: i64 = if prev_num == 0 {
            0
        } else {
            let ratio_scaled = current_num
                .checked_mul(prev_den)
                .and_then(|v| v.checked_mul(10_000))
                .and_then(|v| v.checked_div(current_den.checked_mul(prev_num).unwrap_or(1)))
                .ok_or(VaultError::CalculationFailure)?;
            ratio_scaled as i64 - 10_000
        };

        let vault_balance = spl_token::state::Account::unpack(&vault_token_info.data.borrow())
            .map_err(|_| VaultError::AllocationMismatch)?
            .amount as u128;
        let value = vault_balance
            .checked_mul(current_num)
            .and_then(|v| v.checked_div(current_den))
            .ok_or(VaultError::CalculationFailure)?;

        Ok((yield_bps, value, current_num, current_den))
    }

    /// Winner (highest last-epoch yield) gets `REBALANCE_WINNER_WEIGHT_BPS`;
    /// the rest split what's left, proportional to their own yield (equally
    /// if none of them grew at all).
    fn rebalance_compute_weights(yields: &[i64; MAX_ALLOCATIONS], n: usize) -> [u16; MAX_ALLOCATIONS] {
        let mut winner = 0usize;
        for i in 1..n {
            if yields[i] > yields[winner] {
                winner = i;
            }
        }

        let mut new_weights = [0u16; MAX_ALLOCATIONS];
        if n == 1 {
            new_weights[0] = 10_000;
            return new_weights;
        }

        new_weights[winner] = REBALANCE_WINNER_WEIGHT_BPS;
        let remaining_bps: u32 = 10_000 - REBALANCE_WINNER_WEIGHT_BPS as u32;
        let other_count = (n - 1) as u32;
        let sum_other_positive: i64 = (0..n).filter(|&i| i != winner).map(|i| yields[i].max(0)).sum();

        let mut assigned = 0u32;
        let mut last_other = winner;
        for i in 0..n {
            if i == winner {
                continue;
            }
            last_other = i;
            let w = if sum_other_positive > 0 {
                (remaining_bps as u64 * yields[i].max(0) as u64 / sum_other_positive as u64) as u32
            } else {
                remaining_bps / other_count
            };
            new_weights[i] = w as u16;
            assigned += w;
        }
        new_weights[last_other] = new_weights[last_other].saturating_add((remaining_bps - assigned) as u16);
        new_weights
    }

    /// Pass 1: pull the excess out of every over-target allocation, straight
    /// into the vault authority (not an external wallet — this is an internal
    /// move, not a user withdrawal).
    #[inline(never)]
    #[allow(clippy::too_many_arguments)]
    fn rebalance_withdraw_excess<'a>(
        remaining: &[AccountInfo<'a>],
        n: usize,
        values: &[u128; MAX_ALLOCATIONS],
        rate_num: &[u128; MAX_ALLOCATIONS],
        rate_den: &[u128; MAX_ALLOCATIONS],
        new_weights: &[u16; MAX_ALLOCATIONS],
        total_value: u128,
        vault_authority_info: &AccountInfo<'a>,
        token_program_info: &AccountInfo<'a>,
        clock_info: &AccountInfo<'a>,
        stake_history_info: &AccountInfo<'a>,
        stake_program_info: &AccountInfo<'a>,
        authority_seeds: &[&[u8]],
    ) -> ProgramResult {
        for i in 0..n {
            let target_value = total_value * new_weights[i] as u128 / 10_000;
            if target_value >= values[i] {
                continue;
            }
            let excess_value = values[i] - target_value;
            if excess_value == 0 {
                continue;
            }
            let pool_tokens_out = u64::try_from(
                excess_value
                    .checked_mul(rate_den[i])
                    .and_then(|v| v.checked_div(rate_num[i].max(1)))
                    .ok_or(VaultError::CalculationFailure)?,
            )
            .map_err(|_| VaultError::CalculationFailure)?;
            if pool_tokens_out == 0 {
                continue;
            }

            let base = i * 7;
            Self::cpi_withdraw_sol(
                &remaining[base],
                &remaining[base + 1],
                &remaining[base + 2],
                &remaining[base + 3],
                &remaining[base + 4],
                &remaining[base + 5],
                &remaining[base + 6],
                vault_authority_info,
                vault_authority_info,
                token_program_info,
                clock_info,
                stake_history_info,
                stake_program_info,
                authority_seeds,
                pool_tokens_out,
            )?;
        }
        Ok(())
    }

    /// Pass 2: whatever landed in the vault authority from pass 1 goes into
    /// the (single, for MAX_ALLOCATIONS=2) under-target allocation. With more
    /// than one under-target allocation this would need splitting between
    /// them proportionally — fine today since there's at most one.
    #[inline(never)]
    fn rebalance_deposit_surplus<'a>(
        remaining: &[AccountInfo<'a>],
        n: usize,
        values: &[u128; MAX_ALLOCATIONS],
        new_weights: &[u16; MAX_ALLOCATIONS],
        total_value: u128,
        vault_authority_info: &AccountInfo<'a>,
        system_program_info: &AccountInfo<'a>,
        token_program_info: &AccountInfo<'a>,
        authority_seeds: &[&[u8]],
    ) -> ProgramResult {
        let rent = Rent::get()?;
        let min_rent = rent.minimum_balance(0);

        for i in 0..n {
            let target_value = total_value * new_weights[i] as u128 / 10_000;
            if target_value <= values[i] {
                continue;
            }
            let available = vault_authority_info.lamports().saturating_sub(min_rent);
            if available == 0 {
                continue;
            }
            let base = i * 7;
            let accs: AllocAccounts = (
                remaining[base].clone(),
                remaining[base + 1].clone(),
                remaining[base + 2].clone(),
                remaining[base + 3].clone(),
                remaining[base + 4].clone(),
                remaining[base + 5].clone(),
                remaining[base + 6].clone(),
            );
            Self::cpi_deposit_sol(
                &accs,
                vault_authority_info,
                system_program_info,
                token_program_info,
                authority_seeds,
                available,
            )?;
        }
        Ok(())
    }

    #[inline(never)]
    fn read_allocation(
        pool_info: &AccountInfo,
        vault_token_info: &AccountInfo,
        vault_authority: &Pubkey,
        weight_bps: u16,
    ) -> Result<Allocation, ProgramError> {
        let stake_pool = solana_program::borsh0_10::try_from_slice_unchecked::<StakePool>(&pool_info.data.borrow())
            .map_err(|_| VaultError::InvalidUnderlyingPool)?;
        if !stake_pool.is_valid() {
            return Err(VaultError::InvalidUnderlyingPool.into());
        }

        let (pool_withdraw_authority, _) =
            Pubkey::find_program_address(&[pool_info.key.as_ref(), b"withdraw"], pool_info.owner);

        let vault_token_account = spl_token::state::Account::unpack(&vault_token_info.data.borrow())
            .map_err(|_| VaultError::AllocationMismatch)?;
        if vault_token_account.mint != stake_pool.pool_mint || vault_token_account.owner != *vault_authority {
            return Err(VaultError::AllocationMismatch.into());
        }

        Ok(Allocation {
            pool_program_id: *pool_info.owner,
            pool_address: *pool_info.key,
            pool_withdraw_authority,
            reserve_stake: stake_pool.reserve_stake,
            pool_mint: stake_pool.pool_mint,
            manager_fee_account: stake_pool.manager_fee_account,
            vault_token_account: *vault_token_info.key,
            weight_bps,
        })
    }

    #[inline(never)]
    fn check_vault_pdas(
        program_id: &Pubkey,
        vault_config: &VaultConfig,
        vault_config_info: &AccountInfo,
        vault_authority_info: &AccountInfo,
        label_mint_info: &AccountInfo,
    ) -> ProgramResult {
        if !vault_config.is_initialized {
            return Err(VaultError::NotInitialized.into());
        }
        if vault_config.label_mint != *label_mint_info.key {
            return Err(VaultError::AllocationMismatch.into());
        }
        let (expected_vault_config, _) = find_vault_config_address(program_id, label_mint_info.key);
        if expected_vault_config != *vault_config_info.key {
            return Err(VaultError::InvalidVaultConfig.into());
        }
        let (expected_vault_authority, _) =
            find_vault_authority_address(program_id, label_mint_info.key);
        if expected_vault_authority != *vault_authority_info.key {
            return Err(VaultError::InvalidVaultAuthority.into());
        }
        Ok(())
    }

    #[inline(never)]
    fn withdraw_share(
        vault_token_info: &AccountInfo,
        label_tokens_in: u64,
        label_supply_before: u64,
    ) -> Result<u64, ProgramError> {
        let vault_token_balance = spl_token::state::Account::unpack(&vault_token_info.data.borrow())
            .map_err(|_| VaultError::AllocationMismatch)?
            .amount;
        u64::try_from(
            (vault_token_balance as u128)
                .checked_mul(label_tokens_in as u128)
                .and_then(|v| v.checked_div(label_supply_before as u128))
                .ok_or(VaultError::CalculationFailure)?,
        )
        .map_err(|_| VaultError::CalculationFailure.into())
    }

    #[inline(never)]
    fn value_of_allocation(pool_info: &AccountInfo, vault_token_info: &AccountInfo) -> Result<u128, ProgramError> {
        let stake_pool = solana_program::borsh0_10::try_from_slice_unchecked::<StakePool>(&pool_info.data.borrow())
            .map_err(|_| VaultError::InvalidUnderlyingPool)?;
        let vault_token_balance = spl_token::state::Account::unpack(&vault_token_info.data.borrow())
            .map_err(|_| VaultError::AllocationMismatch)?
            .amount;
        (vault_token_balance as u128)
            .checked_mul(stake_pool.total_lamports as u128)
            .and_then(|v| v.checked_div(stake_pool.pool_token_supply.max(1) as u128))
            .ok_or_else(|| VaultError::CalculationFailure.into())
    }

    #[inline(never)]
    fn load_vault_config(
        program_id: &Pubkey,
        vault_config_info: &AccountInfo,
        vault_authority_info: &AccountInfo,
        label_mint_info: &AccountInfo,
    ) -> Result<VaultConfig, ProgramError> {
        let vault_config = solana_program::borsh0_10::try_from_slice_unchecked::<VaultConfig>(&vault_config_info.data.borrow())
            .map_err(|_| VaultError::NotInitialized)?;
        Self::check_vault_pdas(
            program_id,
            &vault_config,
            vault_config_info,
            vault_authority_info,
            label_mint_info,
        )?;
        Ok(vault_config)
    }

    #[inline(never)]
    fn deposit_scan_allocations<'a>(
        allocations: &[Allocation],
        remaining: &[AccountInfo<'a>],
    ) -> Result<(Vec<AllocAccounts<'a>>, u128), ProgramError> {
        let mut allocation_accounts = Vec::with_capacity(allocations.len());
        let mut nav_before: u128 = 0;
        for (i, expected) in allocations.iter().enumerate() {
            let base = i * 7;
            let pool_program_info = &remaining[base];
            let pool_info = &remaining[base + 1];
            let pool_withdraw_authority_info = &remaining[base + 2];
            let reserve_stake_info = &remaining[base + 3];
            let vault_token_info = &remaining[base + 4];
            let manager_fee_info = &remaining[base + 5];
            let pool_mint_info = &remaining[base + 6];

            Self::check_allocation_accounts(
                expected,
                pool_program_info,
                pool_info,
                pool_withdraw_authority_info,
                reserve_stake_info,
                vault_token_info,
                manager_fee_info,
                pool_mint_info,
            )?;

            let value = Self::value_of_allocation(pool_info, vault_token_info)?;
            nav_before = nav_before
                .checked_add(value)
                .ok_or(VaultError::CalculationFailure)?;

            allocation_accounts.push((
                pool_program_info.clone(),
                pool_info.clone(),
                pool_withdraw_authority_info.clone(),
                reserve_stake_info.clone(),
                vault_token_info.clone(),
                manager_fee_info.clone(),
                pool_mint_info.clone(),
            ));
        }
        Ok((allocation_accounts, nav_before))
    }

    #[inline(never)]
    fn cpi_deposit_sol<'a>(
        accs: &AllocAccounts<'a>,
        vault_authority_info: &AccountInfo<'a>,
        system_program_info: &AccountInfo<'a>,
        token_program_info: &AccountInfo<'a>,
        authority_seeds: &[&[u8]],
        amount: u64,
    ) -> ProgramResult {
        let (
            pool_program_info,
            pool_info,
            pool_withdraw_authority_info,
            reserve_stake_info,
            vault_token_info,
            manager_fee_info,
            pool_mint_info,
        ) = accs;
        let ix = spl_stake_pool::instruction::deposit_sol(
            pool_program_info.key,
            pool_info.key,
            pool_withdraw_authority_info.key,
            reserve_stake_info.key,
            vault_authority_info.key,
            vault_token_info.key,
            manager_fee_info.key,
            vault_token_info.key,
            pool_mint_info.key,
            token_program_info.key,
            amount,
        );
        invoke_signed(
            &ix,
            &[
                pool_info.clone(),
                pool_withdraw_authority_info.clone(),
                reserve_stake_info.clone(),
                vault_authority_info.clone(),
                vault_token_info.clone(),
                manager_fee_info.clone(),
                vault_token_info.clone(),
                pool_mint_info.clone(),
                system_program_info.clone(),
                token_program_info.clone(),
            ],
            &[authority_seeds],
        )
    }

    #[inline(never)]
    #[allow(clippy::too_many_arguments)]
    fn cpi_withdraw_sol<'a>(
        pool_program_info: &AccountInfo<'a>,
        pool_info: &AccountInfo<'a>,
        pool_withdraw_authority_info: &AccountInfo<'a>,
        reserve_stake_info: &AccountInfo<'a>,
        vault_token_info: &AccountInfo<'a>,
        manager_fee_info: &AccountInfo<'a>,
        pool_mint_info: &AccountInfo<'a>,
        withdrawer_wallet_info: &AccountInfo<'a>,
        vault_authority_info: &AccountInfo<'a>,
        token_program_info: &AccountInfo<'a>,
        clock_info: &AccountInfo<'a>,
        stake_history_info: &AccountInfo<'a>,
        stake_program_info: &AccountInfo<'a>,
        authority_seeds: &[&[u8]],
        pool_tokens_out: u64,
    ) -> ProgramResult {
        let ix = spl_stake_pool::instruction::withdraw_sol(
            pool_program_info.key,
            pool_info.key,
            pool_withdraw_authority_info.key,
            vault_authority_info.key,
            vault_token_info.key,
            reserve_stake_info.key,
            withdrawer_wallet_info.key,
            manager_fee_info.key,
            pool_mint_info.key,
            token_program_info.key,
            pool_tokens_out,
        );
        invoke_signed(
            &ix,
            &[
                pool_info.clone(),
                pool_withdraw_authority_info.clone(),
                vault_authority_info.clone(),
                vault_token_info.clone(),
                reserve_stake_info.clone(),
                withdrawer_wallet_info.clone(),
                manager_fee_info.clone(),
                pool_mint_info.clone(),
                clock_info.clone(),
                stake_history_info.clone(),
                stake_program_info.clone(),
                token_program_info.clone(),
            ],
            &[authority_seeds],
        )
    }

    #[inline(never)]
    #[allow(clippy::too_many_arguments)]
    fn check_allocation_accounts(
        expected: &Allocation,
        pool_program_info: &AccountInfo,
        pool_info: &AccountInfo,
        pool_withdraw_authority_info: &AccountInfo,
        reserve_stake_info: &AccountInfo,
        vault_token_info: &AccountInfo,
        manager_fee_info: &AccountInfo,
        pool_mint_info: &AccountInfo,
    ) -> ProgramResult {
        if *pool_program_info.key != expected.pool_program_id
            || *pool_info.key != expected.pool_address
            || *pool_withdraw_authority_info.key != expected.pool_withdraw_authority
            || *reserve_stake_info.key != expected.reserve_stake
            || *vault_token_info.key != expected.vault_token_account
            || *manager_fee_info.key != expected.manager_fee_account
            || *pool_mint_info.key != expected.pool_mint
        {
            return Err(VaultError::AllocationMismatch.into());
        }
        Ok(())
    }
}
