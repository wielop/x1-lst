export default function Architecture() {
  return (
    <article>
      <h1>Architecture</h1>
      <p>Two on-chain programs, both deployed to X1 testnet.</p>

      <h2>1. Base stake pool (spl-stake-pool)</h2>
      <p>
        Unmodified Solana Labs <code>spl-stake-pool</code> source (the <code>stake-pool-v1.0.0</code>{" "}
        tag, chosen specifically because it&apos;s the newest version whose{" "}
        <code>solana-program</code> dependency still builds with X1&apos;s current{" "}
        <code>cargo build-sbf</code> toolchain). Program:{" "}
        <code>HjJ81j6LvguqZP17WwPrWihqpCqWYMqPdVCEDtDXDd23</code>. A <code>StakePool</code> account
        stores manager/staker authorities, the reserve stake account, the pool mint, and fee
        config; a <code>ValidatorList</code> account tracks per-validator active/transient stake.
      </p>

      <h2>2. label-vault (custom)</h2>
      <p>
        A native Solana program (no Anchor) written for this project. Key accounts, both PDAs
        derived from the Label&apos;s mint:
      </p>
      <ul>
        <li>
          <code>vault_config</code> (seeds <code>[b&quot;vault_config&quot;, label_mint]</code>) —
          stores the creator, the label mint, and up to <code>MAX_ALLOCATIONS</code> allocation
          records (each: the underlying pool&apos;s program id, address, withdraw authority,
          reserve, mint, fee account, this vault&apos;s own token account for it, and its weight
          in basis points).
        </li>
        <li>
          <code>vault_authority</code> (seeds <code>[b&quot;vault_authority&quot;, label_mint]</code>)
          — the label mint&apos;s mint authority, and the signer (via <code>invoke_signed</code>)
          for every CPI into an underlying pool. It briefly holds deposited XNT during a deposit,
          and directly owns the vault&apos;s per-allocation token accounts.
        </li>
      </ul>
      <p>
        Allocation metadata is read live from each underlying pool&apos;s own{" "}
        <code>StakePool</code> account at <code>CreateLabel</code>{" "}
        time — never trusted from
        client input — so a Label can point at any stake-pool-family deployment, including ones
        this project doesn&apos;t control.
      </p>

      <h3>Rebalance</h3>
      <p>
        Restricted to <code>vault_config.creator</code> — deliberately not a public,
        anyone-can-call instruction like <code>spl-stake-pool</code>&apos;s own{" "}
        <code>update</code>, since letting anyone trigger fund movement out of arbitrary pools
        into others is a meaningfully bigger attack surface than letting anyone refresh balances.
        For each allocation:
      </p>
      <ol>
        <li>
          Reads <code>total_lamports</code> / <code>pool_token_supply</code> (current exchange
          rate) and <code>last_epoch_total_lamports</code> / <code>last_epoch_pool_token_supply</code>{" "}
          (rate one epoch ago) straight off the pool&apos;s own <code>StakePool</code> account —
          both already maintained by spl-stake-pool itself for its own epoch-fee accounting, so
          no extra bookkeeping needed on our side.
        </li>
        <li>
          Computes each allocation&apos;s last-epoch yield in basis points via cross-multiplication
          (avoids an intermediate float and the rounding that comes with it), ranks them, and
          assigns the winner <code>REBALANCE_WINNER_WEIGHT_BPS</code> (70%) — the rest split what
          remains, proportional to their own (non-negative) yield.
        </li>
        <li>
          Values each allocation at its current rate, diffs against the new target weight, and —
          in the same instruction — CPIs <code>WithdrawSol</code> out of every now-over-target
          allocation straight into the vault authority, then <code>DepositSol</code>{" "}
          for whatever landed there into the under-target one. Two passes (all withdrawals, then
          deposits) so
          a later deposit can draw on lamports an earlier withdrawal just freed.
        </li>
        <li>Writes the new weights back into <code>vault_config</code>.</li>
      </ol>
      <p>
        With <code>MAX_ALLOCATIONS</code> at 2 there&apos;s always exactly one winner and one
        loser, so &quot;deposit whatever the withdrawals freed into the one under-target
        allocation&quot; is exact. Past 2 allocations this would need to split the deposit side
        across multiple under-target allocations proportionally too — not implemented, since
        there&apos;s nothing to test it against yet.
      </p>

      <h3>Why label-vault uses spl-stake-pool as a Rust dependency</h3>
      <p>
        Not to build or deploy it again — just to reuse its instruction builders (
        <code>deposit_sol</code>, <code>withdraw_sol</code>) and its <code>StakePool</code> struct
        for reading exchange rates. Since the target program ID is passed as data, not hardcoded,
        the same builder works against any deployment of the same program family.
      </p>

      <h3>Two SBF stack-frame lessons learned building this</h3>
      <p>
        Solana&apos;s BPF/SBF runtime gives each function call a 4KB stack frame. Two gotchas hit
        repeatedly while getting label-vault working, both worth knowing before extending it:
      </p>
      <ol>
        <li>
          Any per-instruction handler large enough to get inlined into the shared dispatcher can
          blow the 4KB limit — and the compiler&apos;s stack-size warning doesn&apos;t reliably
          catch it. Every non-trivial handler, and every per-loop-iteration body, is marked{" "}
          <code>#[inline(never)]</code> so each gets its own frame that&apos;s freed after each
          call rather than accumulating.
        </li>
        <li>
          Borsh&apos;s derived, checked <code>try_from_slice</code> (which verifies every byte
          gets consumed) uses measurably more stack than{" "}
          <code>solana_program::borsh0_10::try_from_slice_unchecked</code> for the exact same
          struct — large account reads use the unchecked variant even where there&apos;s no real
          size mismatch to guard against. This is why <code>MAX_ALLOCATIONS</code> is only 2 for
          now: raising it needs a hand-rolled, stack-lighter deserializer for{" "}
          <code>VaultConfig</code>.
        </li>
      </ol>

      <h2>Frontend</h2>
      <p>
        Next.js app in <code>web/</code>. <code>lib/stake-pool/</code> is the matching-version JS
        client vendored from the same tag as the on-chain program (later npm versions of{" "}
        <code>@solana/spl-stake-pool</code> target a different account layout).{" "}
        <code>lib/labelVault.ts</code> hand-encodes label-vault instructions since that program
        has no existing SDK.
      </p>
    </article>
  );
}
