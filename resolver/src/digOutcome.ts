import { createHmac } from "node:crypto";

export interface RarityTierConfig {
  rewardBps: number;
  baseChanceBps: number;
  /** duration_scaling[durationTier], basis points multiplier on baseChanceBps */
  durationScaling: [number, number, number];
}

/**
 * Deterministically derives which (if any) bonus rarity tier a dig session
 * hits, from the (secret) server seed + session id + client seed — same
 * commit-reveal fairness property as deriveMineSet in mineLayout.ts.
 *
 * Only the RNG roll happens here; the on-chain program independently
 * computes the floor amount and looks up the bonus tier's `reward_bps`
 * itself — this function only ever needs to return which tier (if any) was
 * hit, never a token amount, since the resolver is not trusted for amounts,
 * only for the roll.
 *
 * Mirrors the sequential-bucket tier-selection pattern already used by
 * swap_router's pick_pool_pct (GigaSwap) for consistency across the
 * ecosystem's provably-fair mechanisms.
 */
export function deriveDigOutcome(
  serverSeed: Buffer,
  sessionId: bigint,
  clientSeed: Buffer,
  durationTier: number,
  rarityTiers: RarityTierConfig[],
): number /* rarity tier index, or 0xFF for none */ {
  const digest = createHmac("sha256", serverSeed)
    .update("dig:" + sessionId.toString())
    .update(clientSeed)
    .digest();

  // 16 bits of precision, matches the on-chain bps (0-10000) scale.
  const roll = digest.readUInt16BE(0) % 10_000;

  let cumulative = 0;
  for (let i = 0; i < rarityTiers.length; i++) {
    const tier = rarityTiers[i];
    const scaling = tier.durationScaling[durationTier] ?? 0;
    const effectiveChance = Math.floor((tier.baseChanceBps * scaling) / 10_000);
    cumulative += effectiveChance;
    if (roll < cumulative) {
      return i;
    }
  }
  return 0xff;
}
