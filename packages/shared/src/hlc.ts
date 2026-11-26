// Hybrid Logical Clock packed as "<15-digit ms>:<5-char base36 counter>:<node>" so plain string
// comparison orders events causally, with the node id as the final tie-breaker.

export type Hlc = { ts: number; counter: number; node: string };

const TS_WIDTH = 15;
const COUNTER_WIDTH = 5;
const MAX_COUNTER = 36 ** COUNTER_WIDTH - 1;

export function packHlc({ ts, counter, node }: Hlc): string {
  if (!Number.isSafeInteger(ts) || ts < 0) throw new Error(`invalid HLC ts: ${ts}`);
  if (!Number.isInteger(counter) || counter < 0 || counter > MAX_COUNTER) throw new Error(`invalid HLC counter: ${counter}`);
  if (!node || node.includes(":")) throw new Error(`invalid HLC node: ${node}`);
  return `${String(ts).padStart(TS_WIDTH, "0")}:${counter.toString(36).padStart(COUNTER_WIDTH, "0")}:${node}`;
}

const HLC_RE = /^(\d{15}):([0-9a-z]{5}):([^:]+)$/;

export function parseHlc(packed: string): Hlc {
  const m = HLC_RE.exec(packed);
  if (!m) throw new Error(`invalid HLC: ${packed}`);
  return { ts: Number(m[1]), counter: parseInt(m[2]!, 36), node: m[3]! };
}

export function isHlc(value: unknown): value is string {
  return typeof value === "string" && HLC_RE.test(value);
}

/** Local event or send. */
export function nextHlc(prev: Hlc, now: number = Date.now()): Hlc {
  if (now > prev.ts) return { ts: now, counter: 0, node: prev.node };
  return { ts: prev.ts, counter: prev.counter + 1, node: prev.node };
}

/** Merge a remote clock into the local one. Throws if the remote is too far ahead of wall time. */
export function receiveHlc(local: Hlc, remote: Hlc, now: number = Date.now(), maxDriftMs = 60_000): Hlc {
  if (remote.ts - now > maxDriftMs) throw new Error(`remote HLC drift ${remote.ts - now}ms exceeds ${maxDriftMs}ms`);
  const ts = Math.max(local.ts, remote.ts, now);
  let counter: number;
  if (ts === local.ts && ts === remote.ts) counter = Math.max(local.counter, remote.counter) + 1;
  else if (ts === local.ts) counter = local.counter + 1;
  else if (ts === remote.ts) counter = remote.counter + 1;
  else counter = 0;
  return { ts, counter, node: local.node };
}

export function compareHlc(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type ClockStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

/**
 * Local HLC that survives reloads and advances past every remote clock it observes, so a device with
 * a lagging wall clock still produces later timestamps than the writes it has seen.
 */
export function persistentClock(storage: ClockStorage, node: string, key = "hlc-clock", maxDriftMs = 5 * 60_000) {
  const saved = storage.getItem(key);
  let clock: Hlc = saved && isHlc(saved) ? { ...parseHlc(saved), node } : { ts: 0, counter: 0, node };
  const set = (next: Hlc) => {
    clock = next;
    const packed = packHlc(clock);
    storage.setItem(key, packed);
    return packed;
  };
  return {
    tick: (now = Date.now()) => set(nextHlc(clock, now)),
    /** Merges a remote clock; ignores malformed, already-seen or implausibly-future values. */
    observe(remote: string, now = Date.now()) {
      if (!isHlc(remote) || remote <= packHlc(clock)) return;
      const parsed = parseHlc(remote);
      if (parsed.ts - now > maxDriftMs) return;
      set(receiveHlc(clock, parsed, now, maxDriftMs));
    },
  };
}
