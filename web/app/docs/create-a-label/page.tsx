import Link from "next/link";

export default function CreateALabelDocs() {
  return (
    <article>
      <h1>Create a Label</h1>
      <p>
        A <strong>Label</strong> is a user-created basket vault, modeled on{" "}
        <a href="https://clearsol.network" target="_blank" rel="noreferrer">
          ClearSol
        </a>
        . Instead of holding a single LST, a Label splits a deposit across several underlying
        stake-pool-family LSTs and mints one share token representing the blended
        position — diversified yield without giving up liquidity.
      </p>

      <h2>Why a basket instead of one pool</h2>
      <p>
        Different LSTs delegate to different validator sets and can accrue rewards at slightly
        different rates. A basket smooths that out and means you&apos;re not fully exposed to any
        one pool operator&apos;s choices.
      </p>

      <h2>You don&apos;t choose the split — the system does</h2>
      <p>
        Early on, <Link href="/create">Create a Label</Link>{" "}
        asked you to pick a percentage for each underlying pool by hand. That didn&apos;t make sense: a static, user-guessed split
        is exactly what a system that&apos;s supposed to chase the best available yield
        shouldn&apos;t rely on. A Label now starts equal-weighted across its pools, and a{" "}
        <code>Rebalance</code> instruction — run by the Label&apos;s creator once per epoch —
        does the job instead:
      </p>
      <ol>
        <li>
          Reads each allocation&apos;s <em>real</em> last-epoch yield straight off its underlying
          pool&apos;s own account (the same fields spl-stake-pool maintains for its own fee
          accounting — nothing bespoke or estimated).
        </li>
        <li>
          Shifts weight toward whichever pool actually performed best, capped at 70% so the
          vault is never fully concentrated in one pool&apos;s validator set no matter how far
          ahead it is.
        </li>
        <li>
          Actually moves the capital to match — withdraws the excess out of the now-overweight
          allocation(s) and deposits it into the underweight one(s), in the same transaction.
          Not just a note for future deposits; every epoch's existing balance gets re-aimed at
          the current best performer.
        </li>
      </ol>
      <p>
        See <Link href="/docs/architecture">Architecture</Link> for exactly how that&apos;s
        computed and why it&apos;s operator-triggered rather than a public button.
      </p>

      <h2>What we don&apos;t do</h2>
      <p>
        ClearSol advertises a &quot;CLEAR Boost&quot; of roughly +4.4% on top of base LST yield,
        described only as coming from &quot;exchange rate appreciation&quot; — which is already
        what the base yield is, so that explanation doesn&apos;t actually attribute the extra
        return to anything. We don&apos;t replicate a number we can&apos;t explain: a Label&apos;s
        NAV is exactly the sum of each allocation&apos;s value at that pool&apos;s own real
        exchange rate, and any extra return over holding one LST comes only from Rebalance
        actually picking the better performer more often than not. No fabricated boost, no
        emissions standing in for yield.
      </p>

      <h2>Creating one</h2>
      <ol>
        <li>
          Go to <Link href="/create">Create a Label</Link> and set a symbol, name, and optional
          description. That&apos;s the whole form now — no weights to configure.
        </li>
        <li>
          Confirm. This sends two transactions: one to create your Label&apos;s mint and the
          vault&apos;s token accounts for each underlying LST (equal-weighted to start), and one
          to initialize the Label itself.
        </li>
      </ol>

      <h2>Depositing and withdrawing</h2>
      <p>
        On a Label&apos;s page, a deposit is split across its allocations by their <em>current</em>{" "}
        weight in one transaction (the vault CPIs into each underlying pool&apos;s{" "}
        <code>DepositSol</code>{" "}
        instruction), and shares are minted based on the Label&apos;s NAV
        immediately before your deposit — first depositor gets 1:1, everyone after gets shares
        proportional to what they put in relative to what&apos;s already there. Withdrawing burns
        shares and pulls your proportional slice out of every allocation at once, sent straight to
        your wallet.
      </p>

      <h2>Why only two allocations on testnet, for now</h2>
      <p>
        The vault program currently caps allocations at 2 (see{" "}
        <Link href="/docs/architecture">Architecture</Link> for why — it&apos;s a stack-size
        limit in the on-chain program, not a design choice). Real rXNT and pXNT only exist on X1
        mainnet, and cross-program calls can&apos;t cross clusters, so testnet allocations point
        at two of our own pool instances standing in for them. Before mainnet, allocations would
        point at the real thing.
      </p>
    </article>
  );
}
