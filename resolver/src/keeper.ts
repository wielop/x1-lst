import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import fs from "node:fs";
import { PROGRAM_ID, RPC_URL, RESOLVER_KEYPAIR_PATH } from "./config.js";
import { minesIdl } from "./idl.js";

const KEEPER_INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? 30_000);

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/**
 * Periodically sweeps expired lock/burn Positions and calls
 * `expire_position` for each one that's past its `unlock_at`. That
 * instruction is what actually removes a position's weight from the
 * staking pool (and, for a Lock, returns the principal $MINE) — it's
 * explicitly permissionless (see the comment on `expire_position` in
 * lib.rs) precisely so this keeper can do it without needing the
 * position's owner to come back and reap it themselves. Without this,
 * an abandoned position's weight would sit in the pool indefinitely,
 * reintroducing the exact "permanent free lunch for early stakers"
 * problem the whole v3 redesign exists to fix — see the module comment
 * above `open_burn` in lib.rs.
 *
 * Reuses the resolver's own keypair to pay tx fees — it's already funded
 * and already the signer for every other resolver-driven on-chain call.
 */
export function startKeeper() {
  const connection = new Connection(RPC_URL, "confirmed");
  const keeperKeypair = loadKeypair(RESOLVER_KEYPAIR_PATH);
  const wallet = new Wallet(keeperKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(minesIdl, PROGRAM_ID, provider);

  const [stakingPool] = PublicKey.findProgramAddressSync([Buffer.from("staking_pool_v3")], PROGRAM_ID);
  const [stakeTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("stake_token_vault_v3")], PROGRAM_ID);
  const [stakingAuthority] = PublicKey.findProgramAddressSync([Buffer.from("staking_authority_v3")], PROGRAM_ID);

  async function sweep() {
    try {
      const poolAccount: any = await (program.account as any).stakingPool.fetch(stakingPool).catch(() => null);
      if (!poolAccount) return; // staking pool not initialized yet on this cluster

      // No server-side filter on unlock_at (Anchor/Solana memcmp can't do
      // range comparisons) — fetch every non-expired Position and filter
      // client-side. Fine at the account counts this program will see;
      // revisit with a smarter filter if that ever stops being true.
      const positions: any[] = await (program.account as any).position.all();
      const now = Math.floor(Date.now() / 1000);
      const expired = positions.filter((p) => !p.account.expired && Number(p.account.unlockAt) <= now);

      for (const p of expired) {
        try {
          const ownerMineAta = getAssociatedTokenAddressSync(poolAccount.mineMint, p.account.owner);
          const kindLabel = p.account.kind.lock !== undefined ? "lock" : "burn";
          const sig = await program.methods
            .expirePosition()
            .accounts({
              payer: keeperKeypair.publicKey,
              stakingPool,
              position: p.publicKey,
              stakeTokenVault,
              stakingAuthority,
              ownerMineAta,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
          console.log(
            `[keeper] expired ${kindLabel} position ${p.publicKey.toBase58()} (owner ${p.account.owner.toBase58()}) tx ${sig}`,
          );
        } catch (err: any) {
          console.error(`[keeper] failed to expire position ${p.publicKey.toBase58()}:`, err.message ?? err);
        }
      }
    } catch (err: any) {
      console.error("[keeper] sweep failed:", err.message ?? err);
    }
  }

  sweep();
  setInterval(sweep, KEEPER_INTERVAL_MS);
  console.log(`[keeper] started, sweeping expired staking positions every ${KEEPER_INTERVAL_MS}ms`);
}
