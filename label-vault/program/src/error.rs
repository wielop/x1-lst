use solana_program::{decode_error::DecodeError, program_error::ProgramError};
use thiserror::Error;

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum VaultError {
    #[error("Vault config account already initialized")]
    AlreadyInitialized,
    #[error("Vault config account not initialized")]
    NotInitialized,
    #[error("Allocation weights must sum to 10000 basis points")]
    InvalidWeights,
    #[error("Too many allocations (max 4)")]
    TooManyAllocations,
    #[error("Name or symbol too long")]
    StringTooLong,
    #[error("Underlying pool account is not a valid StakePool")]
    InvalidUnderlyingPool,
    #[error("Account does not match the allocation recorded in this vault")]
    AllocationMismatch,
    #[error("Vault authority PDA derivation mismatch")]
    InvalidVaultAuthority,
    #[error("Vault config PDA derivation mismatch")]
    InvalidVaultConfig,
    #[error("Deposit amount must be greater than zero")]
    ZeroDeposit,
    #[error("Withdraw amount must be greater than zero")]
    ZeroWithdraw,
    #[error("Calculation overflow")]
    CalculationFailure,
    #[error("Only the Label's creator can trigger a rebalance")]
    NotCreator,
}

impl From<VaultError> for ProgramError {
    fn from(e: VaultError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

impl<T> DecodeError<T> for VaultError {
    fn type_of() -> &'static str {
        "VaultError"
    }
}
