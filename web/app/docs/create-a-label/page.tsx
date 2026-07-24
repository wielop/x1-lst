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
        stake-pool-family LSTs by weight and mints one share token representing the blended
        position — diversified yield without giving up liquidity.
      </p>

      <h2>Why a basket instead of one pool</h2>
      <p>
        Different LSTs delegate to different validator sets and can accrue rewards at slightly
        different rates. A basket smooths that out and means you&apos;re not fully exposed to any
        one pool operator&apos;s choices.
      </p>

      <h2>What we don&apos;t do</h2>
      <p>
        ClearSol advertises a &quot;CLEAR Boost&quot; of roughly +4.4% on top of base LST yield,
        described only as coming from &quot;exchange rate appreciation&quot; — which is already
        what the base yield is, so that explanation doesn&apos;t actually attribute the extra
        return to anything. We don&apos;t replicate a number we can&apos;t explain: a Label&apos;s
        NAV is exactly the sum of each allocation&apos;s value at that pool&apos;s own real
        exchange rate. No fabricated boost, no emissions standing in for yield.
      </p>

      <h2>Creating one</h2>
      <ol>
        <li>
          Go to <Link href="/create">Create a Label</Link> and set a symbol, name, and optional
          description.
        </li>
        <li>
          Choose allocation weights across the available underlying pools — they must sum to
          100%. On testnet there are two (standing in for what would be real LSTs like Ripper
          Pool / the X1 Delegation Program on mainnet — see the note below).
        </li>
        <li>
          Review and confirm. This sends two transactions: one to create your Label&apos;s mint
          and the vault&apos;s token accounts for each underlying LST, and one to initialize the
          Label itself.
        </li>
      </ol>

      <h2>Depositing and withdrawing</h2>
      <p>
        On a Label&apos;s page, a deposit is split across its allocations by weight in one
        transaction (the vault CPIs into each underlying pool&apos;s <code>DepositSol</code>{" "}
        instruction), and shares are minted based on the Label&apos;s NAV immediately before your
        deposit — first depositor gets 1:1, everyone after gets shares proportional to what they
        put in relative to what&apos;s already there. Withdrawing burns shares and pulls your
        proportional slice out of every allocation at once, sent straight to your wallet.
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
