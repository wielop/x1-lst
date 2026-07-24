pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

#[cfg(not(feature = "no-entrypoint"))]
pub mod entrypoint;

solana_program::declare_id!("HuxK4tFifoCfUzN1asHf5xae7XqszmkEC9gMvxPSVekG");
