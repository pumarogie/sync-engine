export type Peer = { clientId: number; name: string; color: string };

export function samePeers(a: Peer[], b: Peer[]): boolean {
  return a.length === b.length && a.every((p, i) => p.clientId === b[i]!.clientId && p.name === b[i]!.name && p.color === b[i]!.color);
}
