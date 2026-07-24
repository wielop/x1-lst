use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program, sysvar,
};

use crate::state::{MAX_NAME_LEN, MAX_SYMBOL_LEN};

pub const VAULT_CONFIG_SEED: &[u8] = b"vault_config";
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";

pub fn find_vault_config_address(program_id: &Pubkey, label_mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_CONFIG_SEED, label_mint.as_ref()], program_id)
}

pub fn find_vault_authority_address(program_id: &Pubkey, label_mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_AUTHORITY_SEED, label_mint.as_ref()], program_id)
}

/// One allocation target passed into `CreateLabel`, before the program has
/// read the underlying pool's own state to fill in the rest.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub struct AllocationInput {
    pub weight_bps: u16,
}

#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub enum VaultInstruction {
    /// Creates a new Label — a basket vault allocating deposits across the
    /// underlying pools passed in the accounts list.
    ///
    /// Accounts, in order:
    ///   0. `[s, w]` Creator / payer
    ///   1. `[w]` Vault config PDA (uninitialized, seeds \[b"vault_config", label_mint\])
    ///   2. `[]` Vault authority PDA (seeds \[b"vault_authority", label_mint\]) — must be
    ///      the mint authority of `label_mint`
    ///   3. `[]` Label mint (already created + initialized off-chain, zero supply)
    ///   4. `[]` System program
    ///   Then, for each allocation (2 accounts per allocation, order matches `weights`):
    ///     `[]` Underlying StakePool account (owner = that pool's program)
    ///     `[]` This vault's token account for that pool's LST (owner = vault authority)
    CreateLabel {
        name: [u8; MAX_NAME_LEN],
        symbol: [u8; MAX_SYMBOL_LEN],
        weights_bps: Vec<u16>,
    },

    /// Deposits XNT, split across the vault's allocations by weight, and
    /// mints label tokens to the depositor based on NAV at the start of the
    /// instruction.
    ///
    /// Accounts, in order:
    ///   0. `[s, w]` Depositor
    ///   1. `[w]` Vault config PDA
    ///   2. `[]` Vault authority PDA
    ///   3. `[w]` Label mint
    ///   4. `[w]` Depositor's label token account
    ///   5. `[]` Token program
    ///   6. `[]` System program
    ///   Then, for each allocation (7 accounts per allocation, in the order stored
    ///   in the vault config):
    ///     `[]`  Underlying pool's program (executable)
    ///     `[w]` Underlying StakePool account
    ///     `[]`  Underlying pool's withdraw authority
    ///     `[w]` Underlying pool's reserve stake account
    ///     `[w]` This vault's token account for that pool's LST
    ///     `[w]` Underlying pool's manager fee account
    ///     `[w]` Underlying pool's LST mint
    Deposit { lamports_in: u64 },

    /// Burns label tokens and withdraws a proportional share from each
    /// allocation's reserve, sent directly to the withdrawer.
    ///
    /// Accounts, in order:
    ///   0. `[s]` Withdrawer
    ///   1. `[w]` Vault config PDA
    ///   2. `[]` Vault authority PDA
    ///   3. `[w]` Label mint
    ///   4. `[w]` Withdrawer's label token account
    ///   5. `[]` Token program
    ///   6. `[]` Clock sysvar
    ///   7. `[]` Stake history sysvar
    ///   8. `[]` Stake program
    ///   Then, for each allocation (6 accounts per allocation):
    ///     `[]`  Underlying pool's program (executable)
    ///     `[w]` Underlying StakePool account
    ///     `[]`  Underlying pool's withdraw authority
    ///     `[w]` Underlying pool's reserve stake account
    ///     `[w]` This vault's token account for that pool's LST
    ///     `[w]` Underlying pool's manager fee account
    ///     `[w]` Underlying pool's LST mint
    ///     `[w]` Withdrawer's wallet (destination for XNT)
    Withdraw { label_tokens_in: u64 },
}

pub fn create_label(
    program_id: &Pubkey,
    creator: &Pubkey,
    vault_config: &Pubkey,
    vault_authority: &Pubkey,
    label_mint: &Pubkey,
    allocation_accounts: &[(Pubkey, Pubkey)], // (pool_address, vault_token_account)
    name: [u8; MAX_NAME_LEN],
    symbol: [u8; MAX_SYMBOL_LEN],
    weights_bps: Vec<u16>,
) -> Instruction {
    let mut accounts = vec![
        AccountMeta::new(*creator, true),
        AccountMeta::new(*vault_config, false),
        AccountMeta::new_readonly(*vault_authority, false),
        AccountMeta::new_readonly(*label_mint, false),
        AccountMeta::new_readonly(system_program::id(), false),
    ];
    for (pool_address, vault_token_account) in allocation_accounts {
        accounts.push(AccountMeta::new_readonly(*pool_address, false));
        accounts.push(AccountMeta::new_readonly(*vault_token_account, false));
    }
    Instruction {
        program_id: *program_id,
        accounts,
        data: VaultInstruction::CreateLabel {
            name,
            symbol,
            weights_bps,
        }
        .try_to_vec()
        .unwrap(),
    }
}

pub struct AllocationAccounts {
    pub pool_program_id: Pubkey,
    pub pool_address: Pubkey,
    pub pool_withdraw_authority: Pubkey,
    pub reserve_stake: Pubkey,
    pub vault_token_account: Pubkey,
    pub manager_fee_account: Pubkey,
    pub pool_mint: Pubkey,
}

pub fn deposit(
    program_id: &Pubkey,
    depositor: &Pubkey,
    vault_config: &Pubkey,
    vault_authority: &Pubkey,
    label_mint: &Pubkey,
    depositor_label_token_account: &Pubkey,
    allocations: &[AllocationAccounts],
    lamports_in: u64,
) -> Instruction {
    let mut accounts = vec![
        AccountMeta::new(*depositor, true),
        AccountMeta::new(*vault_config, false),
        AccountMeta::new_readonly(*vault_authority, false),
        AccountMeta::new(*label_mint, false),
        AccountMeta::new(*depositor_label_token_account, false),
        AccountMeta::new_readonly(spl_token::id(), false),
        AccountMeta::new_readonly(system_program::id(), false),
    ];
    for a in allocations {
        accounts.push(AccountMeta::new_readonly(a.pool_program_id, false));
        accounts.push(AccountMeta::new(a.pool_address, false));
        accounts.push(AccountMeta::new_readonly(a.pool_withdraw_authority, false));
        accounts.push(AccountMeta::new(a.reserve_stake, false));
        accounts.push(AccountMeta::new(a.vault_token_account, false));
        accounts.push(AccountMeta::new(a.manager_fee_account, false));
        accounts.push(AccountMeta::new(a.pool_mint, false));
    }
    Instruction {
        program_id: *program_id,
        accounts,
        data: VaultInstruction::Deposit { lamports_in }.try_to_vec().unwrap(),
    }
}

pub fn withdraw(
    program_id: &Pubkey,
    withdrawer: &Pubkey,
    vault_config: &Pubkey,
    vault_authority: &Pubkey,
    label_mint: &Pubkey,
    withdrawer_label_token_account: &Pubkey,
    allocations: &[AllocationAccounts],
    label_tokens_in: u64,
) -> Instruction {
    let mut accounts = vec![
        AccountMeta::new_readonly(*withdrawer, true),
        AccountMeta::new(*vault_config, false),
        AccountMeta::new_readonly(*vault_authority, false),
        AccountMeta::new(*label_mint, false),
        AccountMeta::new(*withdrawer_label_token_account, false),
        AccountMeta::new_readonly(spl_token::id(), false),
        AccountMeta::new_readonly(sysvar::clock::id(), false),
        AccountMeta::new_readonly(sysvar::stake_history::id(), false),
        AccountMeta::new_readonly(solana_program::stake::program::id(), false),
    ];
    for a in allocations {
        accounts.push(AccountMeta::new_readonly(a.pool_program_id, false));
        accounts.push(AccountMeta::new(a.pool_address, false));
        accounts.push(AccountMeta::new_readonly(a.pool_withdraw_authority, false));
        accounts.push(AccountMeta::new(a.reserve_stake, false));
        accounts.push(AccountMeta::new(a.vault_token_account, false));
        accounts.push(AccountMeta::new(a.manager_fee_account, false));
        accounts.push(AccountMeta::new(a.pool_mint, false));
        accounts.push(AccountMeta::new(*withdrawer, false));
    }
    Instruction {
        program_id: *program_id,
        accounts,
        data: VaultInstruction::Withdraw { label_tokens_in }
            .try_to_vec()
            .unwrap(),
    }
}
