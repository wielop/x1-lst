import { Connection } from "@solana/web3.js";

/**
 * Validator selection methodology for the X1 liquid staking pool.
 *
 * Ripper Pool (the only existing X1 LST) filters by a self-stake percentile
 * (P85 x 1, floor 1000 XNT) computed from each validator's own delegated
 * stake, which requires mining individual stake accounts per validator over
 * public RPC. This approximates the same goal (exclude low-commitment,
 * unreliable, or unproven validators) using two standard RPC calls:
 *
 *   1. getVoteAccounts  -> stake, commission, delinquency, vote credits
 *   2. getClusterNodes  -> software version per identity
 *
 * Filters (in order): delinquent, commission too high, stake below floor,
 * latest-epoch vote credits far below the field median (skip-rate proxy),
 * running an uncommon software version. Survivors are ranked by activated
 * stake (a market-trust proxy) and capped at `limit`.
 */

export interface ValidatorCandidate {
  votePubkey: string;
  nodePubkey: string;
  activatedStakeXnt: number;
  commission: number;
  latestEpochCredits: number;
  version: string | null;
  excluded: boolean;
  reason: string;
}

export interface SelectionParams {
  maxCommission: number;
  minStakeXnt: number;
  minCreditRatio: number;
  limit: number;
}

export const DEFAULT_SELECTION_PARAMS: SelectionParams = {
  maxCommission: 10,
  minStakeXnt: 1000,
  minCreditRatio: 0.5,
  limit: 20,
};

function latestCredits(epochCredits: [number, number, number][]): number {
  if (epochCredits.length === 0) return 0;
  const [, credits, prevCredits] = epochCredits[epochCredits.length - 1];
  return credits - prevCredits;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function modalVersions(versions: string[], keepTopN = 3): Set<string> {
  const counts = new Map<string, number>();
  for (const v of versions) counts.set(v, (counts.get(v) ?? 0) + 1);
  return new Set(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, keepTopN)
      .map(([v]) => v),
  );
}

export async function selectValidators(
  connection: Connection,
  params: SelectionParams = DEFAULT_SELECTION_PARAMS,
): Promise<{ candidates: ValidatorCandidate[]; survivors: ValidatorCandidate[] }> {
  const [voteAccounts, clusterNodes] = await Promise.all([
    connection.getVoteAccounts("confirmed"),
    connection.getClusterNodes(),
  ]);

  const versionByNode = new Map(clusterNodes.map((n) => [n.pubkey, n.version ?? null]));
  const delinquentSet = new Set(voteAccounts.delinquent.map((v) => v.votePubkey));
  const all = [...voteAccounts.current, ...voteAccounts.delinquent];

  const commonVersions = modalVersions(
    [...versionByNode.values()].filter((v): v is string => !!v),
  );

  const latestCreditsByVote = new Map(
    all.map((v) => [v.votePubkey, latestCredits(v.epochCredits as [number, number, number][])]),
  );
  const creditMedian = median([...latestCreditsByVote.values()].filter((c) => c > 0));

  const candidates: ValidatorCandidate[] = all.map((v) => {
    const activatedStakeXnt = v.activatedStake / 1e9;
    const version = versionByNode.get(v.nodePubkey) ?? null;
    const credits = latestCreditsByVote.get(v.votePubkey) ?? 0;

    let reason = "ok";
    let excluded = false;

    if (delinquentSet.has(v.votePubkey)) {
      excluded = true;
      reason = "delinquent";
    } else if (v.commission > params.maxCommission) {
      excluded = true;
      reason = `commission ${v.commission}% > max ${params.maxCommission}%`;
    } else if (activatedStakeXnt < params.minStakeXnt) {
      excluded = true;
      reason = `stake ${activatedStakeXnt.toFixed(0)} XNT < min ${params.minStakeXnt}`;
    } else if (creditMedian > 0 && credits < creditMedian * params.minCreditRatio) {
      excluded = true;
      reason = `latest-epoch credits ${credits} < ${params.minCreditRatio}x median (${creditMedian.toFixed(0)}) — likely high skip rate`;
    } else if (version && commonVersions.size > 0 && !commonVersions.has(version)) {
      excluded = true;
      reason = `running uncommon version ${version} (majority run: ${[...commonVersions].join(", ")})`;
    }

    return {
      votePubkey: v.votePubkey,
      nodePubkey: v.nodePubkey,
      activatedStakeXnt,
      commission: v.commission,
      latestEpochCredits: credits,
      version,
      excluded,
      reason,
    };
  });

  const survivors = candidates
    .filter((c) => !c.excluded)
    .sort((a, b) => b.activatedStakeXnt - a.activatedStakeXnt)
    .slice(0, params.limit);

  return { candidates, survivors };
}
