import Link from "next/link";

export default function Faq() {
  return (
    <article>
      <h1>FAQ &amp; Known Issues</h1>

      <h2>Is this live on mainnet?</h2>
      <p>
        No, and it won&apos;t be until testnet validation is complete and reviewed. Every address
        in these docs and in the app refers to X1 testnet.
      </p>

      <h2>Why do reads sometimes fail or show stale data?</h2>
      <p>
        X1 testnet&apos;s public RPC (<code>rpc.testnet.x1.xyz</code>) is a proxy in front of
        multiple backend nodes with inconsistent health — some delinquent, some stuck on a stale
        slot. We&apos;ve independently confirmed intermittent <code>AccountNotFound</code>{" "}
        responses, HTTP 503s, and even a literal <code>&quot;All RPC backends are unavailable&quot;</code>{" "}
        error message, for accounts that definitely exist. It&apos;s not something we can fix from
        here. Every page retries reads a few times before giving up — if something shows
        &quot;—&quot; or an error, wait a moment and it usually resolves on its own.
      </p>

      <h2>Why can a Label only have 2 allocations?</h2>
      <p>
        A stack-size limit in the on-chain program, not a design choice — see{" "}
        <Link href="/docs/architecture">Architecture</Link> for the full explanation. Raising it
        needs a hand-rolled deserializer for the Label&apos;s config account.
      </p>

      <h2>Who decides a Label&apos;s allocation weights?</h2>
      <p>
        Nobody, at creation time — every Label starts equal-weighted across its pools. From
        there, a <code>Rebalance</code> instruction (run by the Label&apos;s creator, typically
        from a script once per epoch — not a public button) shifts weight and actual capital
        toward whichever pool genuinely yielded more last epoch. See{" "}
        <Link href="/docs/create-a-label">Create a Label</Link> for why we removed the earlier
        manual weight picker — a static, user-guessed split defeats the point of a system that&apos;s
        supposed to chase yield on its own.
      </p>

      <h2>Where does a Label&apos;s yield actually come from?</h2>
      <p>
        Purely from the underlying pools&apos; own staking rewards, reflected honestly in their
        exchange rates. See <Link href="/docs/create-a-label">Create a Label</Link> for why we
        specifically avoid ClearSol&apos;s unexplained &quot;boost&quot; framing.
      </p>

      <h2>What happens if I try to withdraw more than the reserve holds?</h2>
      <p>
        The underlying transaction fails — this is the same constraint every spl-stake-pool-family
        LST has. A production deployment would need either a deep enough reserve or a
        withdraw-stake fallback; neither is a priority while everything is testnet-only.
      </p>

      <h2>Is the program audited?</h2>
      <p>
        The base stake pool program is unmodified, previously-audited Solana Labs code (see the{" "}
        <a
          href="https://github.com/solana-labs/solana-program-library"
          target="_blank"
          rel="noreferrer"
        >
          solana-program-library
        </a>{" "}
        repo for audit history). <code>label-vault</code> is new, custom code written for this
        project and has not been audited.
      </p>
    </article>
  );
}
