import Link from "next/link";

export default function GettingStarted() {
  return (
    <article>
      <h1>Getting Started</h1>
      <p>
        X1 Liquid Staking is two things built on the{" "}
        <a href="https://x1.xyz" target="_blank" rel="noreferrer">
          X1
        </a>{" "}
        network:
      </p>
      <ol>
        <li>
          <strong>A liquid staking pool</strong> — stake XNT, receive a token representing your
          share of stake delegated across multiple X1 validators, redeem it later for XNT plus
          rewards. Built on Solana Labs&apos; audited <code>spl-stake-pool</code> program, deployed
          under our own program ID.
        </li>
        <li>
          <strong>Labels</strong> — user-created basket vaults. A Label splits a deposit across
          several underlying LSTs by weight and mints one share token for the blended position,
          the same mechanism as{" "}
          <a href="https://clearsol.network" target="_blank" rel="noreferrer">
            ClearSol
          </a>{" "}
          on Solana.
        </li>
      </ol>

      <h2>Status: testnet only</h2>
      <p>
        Nothing here is deployed to X1 mainnet, and it should not be until testnet validation is
        complete and reviewed. Every address and number in these docs refers to the X1 testnet
        deployment.
      </p>

      <h2>Where to go next</h2>
      <ul>
        <li>
          <Link href="/docs/staking-basics">Staking Basics</Link> — how the base LST pool works,
          fees, and how to deposit/withdraw.
        </li>
        <li>
          <Link href="/docs/create-a-label">Create a Label</Link> — how the basket-vault
          mechanism works and how to make your own.
        </li>
        <li>
          <Link href="/docs/architecture">Architecture</Link> — the two on-chain programs, PDAs,
          and how they compose via CPI.
        </li>
        <li>
          <Link href="/docs/validator-selection">Validator Selection</Link> — the methodology
          behind which validators the pool delegates to.
        </li>
        <li>
          <Link href="/docs/glossary">Glossary</Link> — LST, NAV, PDA, CPI, basis points, and
          the other shorthand used throughout these docs.
        </li>
        <li>
          <Link href="/docs/faq">FAQ &amp; Known Issues</Link> — including a testnet RPC quirk
          worth knowing about before you assume something is broken.
        </li>
      </ul>

      <h2>Source</h2>
      <p>
        Everything here — both on-chain programs and this frontend — is open on{" "}
        <a href="https://github.com/wielop/x1-lst" target="_blank" rel="noreferrer">
          github.com/wielop/x1-lst
        </a>
        .
      </p>
    </article>
  );
}
