import { describe, expect, test } from "bun:test";
import { compareHlc, nextHlc, packHlc, parseHlc, persistentClock, receiveHlc } from "@sync/shared";

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

describe("persistentClock", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  test("survives a reload instead of restarting at ts 0", () => {
    const storage = memory();
    const first = persistentClock(storage, "n");
    const last = [first.tick(100), first.tick(100), first.tick(100)].at(-1)!;
    const reloaded = persistentClock(storage, "n");
    expect(reloaded.tick(50) > last).toBe(true); // wall clock went backwards across the reload
    expect(parseHlc(reloaded.tick(50))).toEqual({ ts: 100, counter: 4, node: "n" });
  });

  test("observing a remote clock makes the next local write win the LWW tie", () => {
    const clock = persistentClock(memory(), "slow");
    const remote = packHlc({ ts: 5_000, counter: 7, node: "fast" });
    clock.observe(remote, 1_000); // this device's wall clock lags by 4s
    const next = clock.tick(1_000);
    expect(next > remote).toBe(true);
    expect(parseHlc(next)).toEqual({ ts: 5_000, counter: 9, node: "slow" });
  });

  test("ignores stale, malformed and far-future remote clocks", () => {
    const storage = memory();
    const clock = persistentClock(storage, "n", "k", 1_000);
    const t = clock.tick(10_000);
    clock.observe(packHlc({ ts: 1, counter: 0, node: "x" }), 10_000);
    clock.observe("garbage", 10_000);
    clock.observe(packHlc({ ts: 999_999, counter: 0, node: "x" }), 10_000);
    expect(storage.getItem("k")).toBe(t);
  });
});
