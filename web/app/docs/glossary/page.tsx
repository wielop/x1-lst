export default function Glossary() {
  const terms: [string, string][] = [
    ["LST", "Liquid staking token — a tradeable token representing staked XNT plus accrued rewards, redeemable for the underlying stake."],
    ["Label", "A user-created basket vault (this project's term, borrowed from ClearSol) that splits deposits across multiple LSTs and mints one share token."],
    ["NAV", "Net asset value — the total XNT value of everything a Label holds, computed by valuing each allocation at its underlying pool's own exchange rate."],
    ["Exchange rate", "total_lamports / pool_token_supply for a stake pool, or NAV / share supply for a Label. Rises as staking rewards accrue; nothing needs to be manually claimed."],
    ["Basis points (bps)", "1/100th of a percent. 10,000 bps = 100%. Allocation weights and fees are stored this way to avoid floating point in the on-chain program."],
    ["PDA", "Program Derived Address — a deterministic account address derived from seeds and a program ID, with no private key. Programs 'sign' for PDAs they own via invoke_signed."],
    ["CPI", "Cross-Program Invocation — one on-chain program calling an instruction on another program within the same transaction. label-vault CPIs into each underlying pool's DepositSol/WithdrawSol."],
    ["Reserve (stake pool)", "The stake pool's holding account for XNT not yet delegated to a validator. Withdrawals are only instant if the reserve has enough idle XNT."],
    ["Validator", "A node that participates in consensus and earns staking rewards for delegated stake, minus its commission."],
    ["Delinquent", "A validator that has stopped voting recently — automatically excluded by the validator selection methodology."],
    ["Epoch", "A fixed span of slots (X1 testnet: 500 slots, a few minutes). Staking rewards and pool state updates happen on epoch boundaries."],
    ["SBF / BPF", "Solana's on-chain bytecode format and VM. Each function call gets a 4KB stack frame — see Architecture for why that mattered here."],
    ["spl-stake-pool", "Solana Labs' audited, generic liquid-staking program family. This project deploys an unmodified copy under its own program ID rather than writing a new one."],
  ];

  return (
    <article>
      <h1>Glossary</h1>
      <table>
        <tbody>
          {terms.map(([term, def]) => (
            <tr key={term}>
              <td style={{ whiteSpace: "nowrap", fontWeight: 500, color: "#e4e4e7" }}>{term}</td>
              <td>{def}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}
