import { describe, expect, test } from "bun:test";
import { compareRank, rankAfter, rankBefore, rankBetween } from "@sync/shared";

describe("fractional ranks", () => {
  test("before/after/between keep order", () => {
    const a = rankAfter(null);
    const c = rankAfter(a);
    const b = rankBetween(a, c);
    const z = rankBefore(a);
    expect([c, a, b, z].sort()).toEqual([z, a, b, c]);
  });

  test("repeated inserts at the same spot stay strictly ordered", () => {
    let lo = rankAfter(null);
    const hi = rankAfter(lo);
    const seen = [lo];
    for (let i = 0; i < 200; i++) {
      lo = rankBetween(lo, hi);
      seen.push(lo);
    }
    expect([...seen].sort()).toEqual(seen);
    expect(seen.every((r) => r < hi)).toBe(true);
  });

  test("bounds given out of order are swapped (stale concurrent ranks still produce a key)", () => {
    const a = rankAfter(null);
    const c = rankAfter(a);
    const b = rankBetween(c, a);
    expect(a < b && b < c).toBe(true);
  });

  test("malformed keys throw", () => {
    expect(() => rankBetween("", null)).toThrow();
  });

  test("compareRank breaks ties by id", () => {
    const items = [
      { rank: "a1", id: "z" },
      { rank: "a0", id: "y" },
      { rank: "a1", id: "b" },
    ];
    expect(items.sort(compareRank).map((i) => i.id)).toEqual(["y", "b", "z"]);
  });
});
