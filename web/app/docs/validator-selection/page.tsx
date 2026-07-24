import Link from "next/link";

export default function ValidatorSelectionDocs() {
  return (
    <article>
      <h1>Validator Selection</h1>
      <p>
        Which validators the base pool delegates to matters — a bad or malicious validator can
        underperform or get slashed. Ripper Pool, the dominant LST on X1 mainnet, filters
        candidates by a self-stake percentile (P85 × 1, floor 1000 XNT), computed by mining every
        validator&apos;s own stake accounts. That&apos;s accurate but expensive over public RPC.
      </p>

      <h2>Our approximation</h2>
      <p>
        The same goal — exclude low-commitment, unreliable, or unproven validators — using two
        cheap RPC calls instead: <code>getVoteAccounts</code> and <code>getClusterNodes</code>.
        Filters, applied in order:
      </p>
      <ul>
        <li>drop delinquent validators</li>
        <li>drop commission over 10%</li>
        <li>drop activated stake under 1000 XNT (the same floor Ripper uses)</li>
        <li>
          drop validators whose latest-epoch vote credits are under 0.5× the field median — a
          skip-rate proxy that doesn&apos;t require reconciling the leader schedule slot by slot
        </li>
        <li>drop validators not running one of the network&apos;s most common software versions</li>
      </ul>
      <p>Survivors are ranked by activated stake — a market-trust proxy, since other stakers already picked these validators — and capped at a configurable limit.</p>

      <h2>Where to see it run</h2>
      <p>
        Live on the <Link href="/dashboard">Dashboard</Link>, backed by <code>/api/validators</code>.
        It&apos;s a read-only report — actually adding a validator to the pool still requires the
        staker keypair and is done out-of-band via the CLI, never exposed through the deployed
        site.
      </p>

      <h2>Testnet vs. mainnet</h2>
      <p>
        Testnet has only a handful of vote accounts — mostly bootstrap nodes plus some
        intentionally-delinquent test nodes — so the &quot;top N by stake&quot; result is not
        very meaningful there. The methodology matters more once run against the much larger
        mainnet validator set, which hasn&apos;t happened yet (mainnet deployment is on hold).
      </p>
    </article>
  );
}
