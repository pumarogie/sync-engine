import { generateKeyBetween } from "fractional-indexing";

type Rank = string | null | undefined;

export function rankBetween(before: Rank, after: Rank): string {
  return generateKeyBetween(before ?? null, after ?? null);
}

export function rankBefore(first: Rank): string {
  return generateKeyBetween(null, first ?? null);
}

export function rankAfter(last: Rank): string {
  return generateKeyBetween(last ?? null, null);
}

/** Sort by rank, then id, so concurrent inserts that picked the same rank still order deterministically. */
export function compareRank(a: { rank: string; id: string }, b: { rank: string; id: string }): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
