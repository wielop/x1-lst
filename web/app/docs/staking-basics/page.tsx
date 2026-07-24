import Link from "next/link";

export default function StakingBasics() {
  return (
    <article>
      <h1>Staking Basics</h1>
      <p>
        The base pool is an unmodified deployment of Solana Labs&apos;{" "}
        <code>spl-stake-pool</code> program — the same audited program family used by{" "}
        <a href="https://x1ripper.xyz" target="_blank" rel="noreferrer">
          Ripper Pool
        </a>{" "}
        and the official X1 Delegation Program on mainnet. Depositing XNT gets you a pool token
        (an LST) representing your share of stake delegated across several X1 validators.
      </p>

      <h2>How deposit works</h2>
      <ol>
        <li>Your XNT goes into the pool&apos;s reserve account.</li>
        <li>You receive pool tokens at the current exchange rate — 1:1 the very first time.</li>
        <li>
          The pool&apos;s staker periodically moves reserve XNT into delegated stake with
          validators (see <Link href="/docs/validator-selection">Validator Selection</Link>).
        </li>
        <li>
          As those validators earn staking rewards, the pool&apos;s <code>total_lamports</code>{" "}
          grows relative to the pool token supply — the exchange rate rises, so your existing
          pool tokens become worth more XNT over time. Nothing needs to be claimed manually.
        </li>
      </ol>

      <h2>How withdraw works</h2>
      <p>
        Burn pool tokens, get XNT back at the current exchange rate, minus a withdrawal fee. This
        only works while the pool&apos;s reserve has enough idle XNT to cover it — if all of it is
        delegated to validators, a withdrawal has to wait for the pool to deactivate some stake
        first (the same constraint every user of every spl-stake-pool-family LST faces, not
        specific to this deployment).
      </p>

      <h2>Fees (testnet)</h2>
      <table>
        <thead>
          <tr>
            <th>Fee</th>
            <th>Rate</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Epoch fee (cut of staking rewards)</td>
            <td>5%</td>
          </tr>
          <tr>
            <td>Withdrawal fee</td>
            <td>0.2%</td>
          </tr>
          <tr>
            <td>Deposit fee</td>
            <td>0%</td>
          </tr>
        </tbody>
      </table>
      <p>These mirror Ripper Pool&apos;s published fee schedule.</p>

      <h2>Exchange rate</h2>
      <p>
        <code>exchange_rate = total_lamports / pool_token_supply</code>. You can see the live
        value on the <Link href="/">Stake / Unstake</Link> page and the{" "}
        <Link href="/dashboard">Dashboard</Link>.
      </p>
    </article>
  );
}
