import { compareHlc, type NodeFields } from "@sync/shared";

/** Server-side view of the mergeable node columns (snake_case to match the PowerSync wire format). */
export type NodeState = {
  parent_id: string | null;
  kind: "page" | "database" | "db_row";
  rank: string;
  title: string;
  icon: string | null;
  props: Record<string, unknown>;
  deleted_at: string | null;
  hlc_updated_at: string;
};

const SCALAR_FIELDS = ["parent_id", "kind", "rank", "title", "icon", "deleted_at"] as const;
type ScalarField = (typeof SCALAR_FIELDS)[number];

function same(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

// Timestamps round-trip through SQLite and Postgres in different text formats.
function normalize(field: ScalarField, value: unknown): unknown {
  if (field !== "deleted_at" || typeof value !== "string") return value;
  const ms = Date.parse(value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

function parseProps(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value === "object") return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value));
  } catch {
    return undefined;
  }
}

/**
 * Three-way merge of a client patch onto the current server row.
 *
 * A field (or props key) from the client is applied when either
 *  - the client's HLC is newer than the row's HLC (last-writer-wins), or
 *  - the server value still equals the client's base (`old`) value, i.e. nobody else touched it,
 *    so an older offline edit to a *different* field never clobbers, and is never lost.
 * Without `old` (e.g. a re-PUT) only the HLC decides.
 */
export function mergeNode(
  current: NodeState,
  patch: NodeFields,
  old: Record<string, unknown> | undefined,
): { changes: Partial<NodeState>; hlc: string } {
  const incomingHlc = patch.hlc_updated_at ?? current.hlc_updated_at;
  const newer = compareHlc(incomingHlc, current.hlc_updated_at) > 0;
  const untouched = (base: Record<string, unknown> | undefined, key: string, serverValue: unknown) =>
    base !== undefined && same(base[key], serverValue);

  const changes: Partial<NodeState> = {};
  for (const field of SCALAR_FIELDS) {
    if (!(field in patch)) continue;
    const value = normalize(field, patch[field]);
    const server = normalize(field, current[field]);
    if (same(value, server)) continue;
    const base = old && { [field]: normalize(field, old[field]) };
    if (newer || untouched(base, field, server)) Object.assign(changes, { [field]: value });
  }

  if (patch.props) {
    const base = parseProps(old?.props);
    const merged = { ...current.props };
    let changed = false;
    const keys = new Set([...Object.keys(patch.props), ...Object.keys(base ?? {})]);
    for (const key of keys) {
      const value = patch.props[key];
      if (base && same(base[key], value)) continue; // client did not change this key
      if (same(merged[key], value)) continue;
      if (!newer && !untouched(base, key, merged[key])) continue;
      if (value === undefined) delete merged[key];
      else merged[key] = value;
      changed = true;
    }
    if (changed) changes.props = merged;
  }

  return { changes, hlc: newer ? incomingHlc : current.hlc_updated_at };
}
