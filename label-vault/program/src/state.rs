use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

// NOTE: kept small deliberately — VaultConfig is deserialized via borsh's
// derived impl, and each additional allocation adds ~226 bytes to that one
// on-stack read, which risks exceeding SBF's 4KB-per-frame limit (see
// Processor::load_vault_config). Raise this only alongside switching to a
// hand-rolled, stack-light deserializer, or after confirming --arch sbfv2
// (larger frames) is safe for the target cluster.
pub const MAX_ALLOCATIONS: usize = 2;
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;

/// Rebalance's "chase best yield" cap: the best-performing allocation over
/// the last epoch gets at most this weight, so the vault never goes to 100%
/// in a single underlying pool no matter how far ahead it is.
pub const REBALANCE_WINNER_WEIGHT_BPS: u16 = 7000;

/// One underlying stake-pool-family LST that a portion of deposits is routed into.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, BorshSerialize, BorshDeserialize)]
pub struct Allocation {
    /// Program ID of the underlying stake pool (e.g. Ripper/pXNT's program on mainnet,
    /// or another spl-stake-pool deployment on testnet for testing)
    pub pool_program_id: Pubkey,
    /// The underlying StakePool account
    pub pool_address: Pubkey,
    /// PDA withdraw authority of the underlying pool (derived off-chain, stored for
    /// convenience so instructions don't need to recompute it)
    pub pool_withdraw_authority: Pubkey,
    /// The underlying pool's reserve stake account
    pub reserve_stake: Pubkey,
    /// The underlying pool's LST mint
    pub pool_mint: Pubkey,
    /// The underlying pool's fee-collection token account
    pub manager_fee_account: Pubkey,
    /// This vault's own token account holding the underlying LST (owned by
    /// this vault's authority PDA)
    pub vault_token_account: Pubkey,
    /// Target allocation weight in basis points; all allocations should sum to 10_000
    pub weight_bps: u16,
}

impl Allocation {
    pub const LEN: usize = 32 * 7 + 2;
}

/// A "Label" — one user-created basket vault. Holds a fixed set of allocations
/// across other stake-pool-family LSTs and mints its own share token
/// (`label_mint`) representing a proportional claim on the whole basket.
#[repr(C)]
#[derive(Clone, Debug, PartialEq, BorshSerialize, BorshDeserialize)]
pub struct VaultConfig {
    pub is_initialized: bool,
    pub creator: Pubkey,
    pub label_mint: Pubkey,
    pub vault_authority_bump: u8,
    pub allocation_count: u8,
    pub name: [u8; MAX_NAME_LEN],
    pub symbol: [u8; MAX_SYMBOL_LEN],
    pub allocations: [Allocation; MAX_ALLOCATIONS],
}

impl VaultConfig {
    pub const LEN: usize =
        1 + 32 + 32 + 1 + 1 + MAX_NAME_LEN + MAX_SYMBOL_LEN + MAX_ALLOCATIONS * Allocation::LEN;

    pub fn name_str(&self) -> String {
        String::from_utf8_lossy(&self.name)
            .trim_end_matches('\0')
            .to_string()
    }

    pub fn symbol_str(&self) -> String {
        String::from_utf8_lossy(&self.symbol)
            .trim_end_matches('\0')
            .to_string()
    }

    pub fn active_allocations(&self) -> &[Allocation] {
        &self.allocations[..self.allocation_count as usize]
    }
}

pub fn pack_fixed_str<const N: usize>(s: &str) -> [u8; N] {
    let mut buf = [0u8; N];
    let bytes = s.as_bytes();
    let len = bytes.len().min(N);
    buf[..len].copy_from_slice(&bytes[..len]);
    buf
}
