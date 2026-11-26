export type Peer = { clientId: number; name: string; color: string };

export function samePeers(a: Peer[], b: Peer[]): boolean {
  return a.length === b.length && a.every((p, i) => p.clientId === b[i]!.clientId && p.name === b[i]!.name && p.color === b[i]!.color);
}

/** A page created offline is "not found" until PowerSync uploads it; anything else is a real denial. */
export function isTransientDenial(reason: string): boolean {
  return /not found/i.test(reason);
}

export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 60_000);
}
