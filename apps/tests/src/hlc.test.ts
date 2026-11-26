import { describe, expect, test } from "bun:test";
import { compareHlc, nextHlc, packHlc, parseHlc, receiveHlc } from "@sync/shared";

describe("HLC", () => {
  test("pack/parse round-trips", () => {
    const h = { ts: 1_732_000_000_123, counter: 42, node: "abc" };
    expect(parseHlc(packHlc(h))).toEqual(h);
  });

  test("packed form sorts like (ts, counter, node)", () => {
    const clocks = [
      { ts: 10, counter: 0, node: "b" },
      { ts: 9, counter: 999, node: "z" },
      { ts: 10, counter: 1, node: "a" },
      { ts: 10, counter: 0, node: "a" },
      { ts: 100_000, counter: 0, node: "a" },
    ];
    const sorted = clocks.map(packHlc).sort();
    expect(sorted.map(parseHlc)).toEqual([
      { ts: 9, counter: 999, node: "z" },
      { ts: 10, counter: 0, node: "a" },
      { ts: 10, counter: 0, node: "b" },
      { ts: 10, counter: 1, node: "a" },
      { ts: 100_000, counter: 0, node: "a" },
    ]);
  });

  test("rejects malformed input", () => {
    expect(() => parseHlc("nope")).toThrow();
    expect(() => packHlc({ ts: -1, counter: 0, node: "a" })).toThrow();
    expect(() => packHlc({ ts: 1, counter: 0, node: "a:b" })).toThrow();
  });

  test("nextHlc is monotonic even when the wall clock goes backwards", () => {
    let h = { ts: 0, counter: 0, node: "n" };
    const out: string[] = [];
    for (const now of [100, 100, 90, 101, 101]) {
      h = nextHlc(h, now);
      out.push(packHlc(h));
    }
    expect([...out].sort()).toEqual(out);
    expect(new Set(out).size).toBe(out.length);
    expect(parseHlc(out[2]!)).toEqual({ ts: 100, counter: 2, node: "n" });
  });

  test("receiveHlc advances past both clocks", () => {
    const local = { ts: 100, counter: 5, node: "a" };
    const remote = { ts: 100, counter: 9, node: "b" };
    expect(receiveHlc(local, remote, 50)).toEqual({ ts: 100, counter: 10, node: "a" });
    expect(receiveHlc(local, { ts: 200, counter: 3, node: "b" }, 150)).toEqual({ ts: 200, counter: 4, node: "a" });
    expect(receiveHlc(local, remote, 300)).toEqual({ ts: 300, counter: 0, node: "a" });
  });

  test("receiveHlc rejects excessive drift", () => {
    expect(() => receiveHlc({ ts: 0, counter: 0, node: "a" }, { ts: 1_000_000, counter: 0, node: "b" }, 0, 1000)).toThrow(/drift/);
  });

  test("compareHlc", () => {
    const a = packHlc({ ts: 1, counter: 0, node: "a" });
    const b = packHlc({ ts: 1, counter: 1, node: "a" });
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, a)).toBe(1);
    expect(compareHlc(a, a)).toBe(0);
  });
});
