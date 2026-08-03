import { createHmac } from "node:crypto";

/**
 * Deterministically derives which tiles are mines for a single round from
 * the (secret) server seed, the round id and the player's client seed.
 * Anyone who later learns the raw server seed can recompute this exact set
 * and confirm the resolver never lied about a past round.
 */
export function deriveMineSet(
  serverSeed: Buffer,
  roundId: bigint,
  clientSeed: Buffer,
  mineCount: number,
  totalTiles = 25,
): Set<number> {
  let digest = createHmac("sha256", serverSeed)
    .update(roundId.toString())
    .update(clientSeed)
    .digest();

  let offset = 0;
  const nextByte = (): number => {
    if (offset >= digest.length) {
      digest = createHmac("sha256", serverSeed).update(digest).digest();
      offset = 0;
    }
    return digest[offset++];
  };

  // Seeded Fisher-Yates shuffle; the first `mineCount` tiles after shuffling
  // are the mines. Deterministic and uniform given the HMAC output.
  const tiles = Array.from({ length: totalTiles }, (_, i) => i);
  for (let i = tiles.length - 1; i > 0; i--) {
    const r = nextByte() % (i + 1);
    [tiles[i], tiles[r]] = [tiles[r], tiles[i]];
  }
  return new Set(tiles.slice(0, mineCount));
}
