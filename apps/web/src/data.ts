import {
  column,
  PowerSyncDatabase,
  Schema,
  Table,
  UpdateType,
  WASQLiteVFS,
  type AbstractPowerSyncDatabase,
  type PowerSyncBackendConnector,
} from "@powersync/web";
import { persistentClock, type DemoUserId, type NodeKind, type TokenResponse, type UploadResult } from "@sync/shared";

export const POWERSYNC_URL = import.meta.env.VITE_POWERSYNC_URL ?? `http://${location.hostname}:8080`;
export const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? `ws://${location.hostname}:1234`;

// ---------- session ----------
const tokens = new Map<string, Promise<TokenResponse>>();

export function getToken(userId: DemoUserId): Promise<TokenResponse> {
  const cached = tokens.get(userId);
  if (cached) {
    return cached.then((t) => (t.expiresAt * 1000 - Date.now() > 60_000 ? t : (tokens.delete(userId), getToken(userId))));
  }
  const pending = api<TokenResponse>("/api/auth/token", { method: "POST", body: { userId } });
  pending.catch(() => tokens.delete(userId));
  tokens.set(userId, pending);
  return pending;
}

export async function api<T>(path: string, { method = "GET", body, token }: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${await res.text()}`), { status: res.status });
  return (res.status === 204 ? undefined : await res.json()) as T;
}

// ---------- local schema (mirrors the synced Postgres tables) ----------
const workspaces = new Table({ name: column.text, created_at: column.text });
const workspace_members = new Table(
  { workspace_id: column.text, user_id: column.text, role: column.text, created_at: column.text },
  { indexes: { by_user: ["user_id"] } },
);
const nodes = new Table(
  {
    workspace_id: column.text,
    parent_id: column.text,
    root_space_id: column.text,
    kind: column.text,
    rank: column.text,
    title: column.text,
    icon: column.text,
    props: column.text,
    plain_text_preview: column.text,
    hlc_updated_at: column.text,
    deleted_at: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  // Previous values give the server a merge base, so concurrent edits to different fields both survive.
  { indexes: { by_workspace: ["workspace_id"], by_parent: ["parent_id"], by_hlc: ["hlc_updated_at"] }, trackPrevious: true, ignoreEmptyUpdates: true },
);

export const schema = new Schema({ workspaces, workspace_members, nodes });
export type NodeRow = (typeof schema)["types"]["nodes"];

export function openDatabase(userId: DemoUserId) {
  return new PowerSyncDatabase({
    schema,
    database: { dbFilename: `sync-engine-${userId}.sqlite`, vfs: WASQLiteVFS.OPFSCoopSyncVFS },
  });
}

// ---------- connector ----------
export class Connector implements PowerSyncBackendConnector {
  constructor(private userId: DemoUserId) {}

  async fetchCredentials() {
    const { token, expiresAt } = await getToken(this.userId);
    return { endpoint: POWERSYNC_URL, token, expiresAt: new Date(expiresAt * 1000) };
  }

  async uploadData(db: AbstractPowerSyncDatabase) {
    const clientId = await db.getClientId();
    for (let tx = await db.getNextCrudTransaction(); tx; tx = await db.getNextCrudTransaction()) {
      const entries = tx.crud.map((e) => ({
        mutationId: `${clientId}:${e.clientId}`,
        op: e.op,
        table: e.table,
        id: e.id,
        ...(e.op !== UpdateType.DELETE && { data: e.opData }),
        ...(e.previousValues && { old: e.previousValues }),
      }));
      try {
        const { token } = await getToken(this.userId);
        const result = await api<UploadResult>("/api/sync/upload", { method: "POST", body: { entries }, token });
        if (result.rejected.length) console.warn("[sync] server rejected", result.rejected);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 401) tokens.delete(this.userId);
        // 4xx (except auth) will never succeed: drop the batch; the server state syncs back down.
        if (!status || status >= 500 || status === 401) throw error;
        console.error("[sync] dropping unprocessable batch", error);
      }
      await tx.complete();
    }
  }
}

// ---------- HLC ----------
const HLC_NODE = (() => {
  const key = "hlc-node";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID().slice(0, 8);
  localStorage.setItem(key, id);
  return id;
})();
const clock = persistentClock(localStorage, HLC_NODE);
export const tick = () => clock.tick();

/** Advances the local clock past the newest synced write, so lagging wall clocks don't lose LWW ties. */
export function followRemoteClock(db: AbstractPowerSyncDatabase): () => void {
  const abort = new AbortController();
  db.watch(
    "SELECT max(hlc_updated_at) AS max_hlc FROM nodes",
    [],
    {
      onResult: (r) => {
        const max = r.rows?._array[0]?.max_hlc;
        if (max) clock.observe(max);
      },
    },
    { signal: abort.signal },
  );
  return () => abort.abort();
}

/** Keeps database rows for `databaseId` synced while the caller holds the subscription. */
export function subscribeDatabaseRows(db: AbstractPowerSyncDatabase, databaseId: string): () => void {
  const pending = db.syncStream("database_rows", { database_id: databaseId }).subscribe();
  return () => void pending.then((s) => s.unsubscribe());
}

// ---------- local mutations (instant in SQLite, queued for upload) ----------
type Db = AbstractPowerSyncDatabase;
type EditableField = "title" | "icon" | "rank" | "parent_id" | "kind";

export async function createNode(
  db: Db,
  n: { workspaceId: string; parentId: string | null; kind: NodeKind; rank: string; title?: string; props?: Record<string, unknown> },
): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO nodes (id, workspace_id, parent_id, kind, rank, title, props, hlc_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, n.workspaceId, n.parentId, n.kind, n.rank, n.title ?? "", JSON.stringify(n.props ?? {}), tick()],
  );
  return id;
}

export function updateNode(db: Db, id: string, fields: Partial<Record<EditableField, string | null>>) {
  const keys = Object.keys(fields) as EditableField[];
  return db.execute(`UPDATE nodes SET ${keys.map((k) => `${k} = ?`).join(", ")}, hlc_updated_at = ? WHERE id = ?`, [
    ...keys.map((k) => fields[k]),
    tick(),
    id,
  ]);
}

export function setProp(db: Db, id: string, key: string, value: string) {
  return db.execute(
    `UPDATE nodes SET props = json_set(coalesce(props, '{}'), ?, ?), hlc_updated_at = ? WHERE id = ?`,
    [`$."${key.replace(/"/g, "")}"`, value, tick(), id],
  );
}

export function deleteNode(db: Db, id: string) {
  return db.execute(`UPDATE nodes SET deleted_at = ?, hlc_updated_at = ? WHERE id = ?`, [new Date().toISOString(), tick(), id]);
}
