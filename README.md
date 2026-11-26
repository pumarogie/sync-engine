<img src="assets/icon.svg" width="64" height="64" alt="">

# sync-engine

A local-first, multiplayer, Notion-style workspace. PostgreSQL 18 is the single source of truth. Two sync lanes run on top of it:

```text
                ┌───────────────────────── browser (apps/web) ─────────────────────────┐
                │  React UI                                                           │
                │   ├─ sidebar / database view ── SQLite (OPFS) ◄─► @powersync/web    │
                │   └─ TipTap editor ──────────── Y.Doc ◄─► y-indexeddb               │
                └───────────┬──────────────────────────────┬───────────────────────────┘
          upload queue      │ POST /api/sync/upload        │ WebSocket (Yjs + awareness)
          + JWT             ▼                              ▼
              ┌──────────────────────┐          ┌──────────────────────┐   pub/sub   ┌─────────┐
              │ apps/api (Hono)      │──revoke─►│ apps/collab          │◄───────────►│ Redis 7 │
              │ JWT/JWKS, RBAC,      │  Redis   │ Hocuspocus on Bun    │             └─────────┘
              │ HLC merge, cycles    │          │ snapshots + deltas   │
              └──────────┬───────────┘          └──────────┬───────────┘
                         ▼                                 ▼
              ┌───────────────────────────────────────────────────────┐
              │ PostgreSQL 18 (wal_level=logical, uuidv7())            │
              └──────────┬────────────────────────────────────────────┘
                         │ logical replication (publication `powersync`)
                         ▼
              ┌──────────────────────┐  sync streams (edition 3), scoped by membership
              │ PowerSync service    │──────────────────────────────────► clients
              │ (Postgres bucket     │
              │  storage, JWKS auth) │
              └──────────────────────┘
```

**Structured lane (PowerSync).** This lane carries `workspaces`, `workspace_members` and `nodes` (pages, databases and database rows). Clients read and write a local SQLite database, so every change shows up immediately and keeps working offline. PowerSync queues local writes and uploads them to `POST /api/sync/upload`. That endpoint applies a batch in one Postgres transaction:

- **Idempotent.** Each entry's `mutationId` (`<clientId>:<opId>`) is recorded in `processed_mutations`, so a replayed entry is skipped.
- **RBAC.** Only `owner` and `editor` can write. A rejected entry is rolled back to its savepoint and reported. PowerSync then syncs the authoritative row back to the client.
- **Tree integrity.** When `parent_id` changes, a recursive CTE refuses any move that would create a cycle. Parents must be in the same workspace. `root_space_id` is recomputed for the whole subtree. Tombstoning a node tombstones its subtree.
- **Conflict resolution.** Clients stamp writes with a Hybrid Logical Clock, and PowerSync `trackPrevious` sends the old values as a merge base. For each scalar field, and for each key of `props` (JSONB), the incoming value wins when its HLC is newer **or** the server value still equals the client's base. Concurrent offline edits to different fields therefore both survive. Real same-field conflicts go to the newer HLC. Clocks more than 5 minutes in the future are rejected.

**Rich-text lane (Yjs).** Each page body is a `Y.Doc` that TipTap edits. `y-indexeddb` persists it locally for offline use, and `@hocuspocus/provider` syncs it. `apps/collab` runs Hocuspocus on Bun's native WebSocket server. Hocuspocus's bundled server uses a Node-only adapter, so Hocuspocus is wired into `Bun.serve` directly. On connect it verifies the RS256 JWT against the API's JWKS and checks membership. Viewers get `readOnly` connections. Redis fans updates out between instances.

Persistence appends each delta to `doc_updates`. After 25 deltas it compacts them into `doc_snapshots`. It also mirrors the plain text into `nodes.plain_text_preview`, which PowerSync replicates, so local search covers page bodies too. When a member is removed or their role changes, the API publishes on the `collab:revoke` Redis channel and collab closes that user's open sockets.

## Layout

```text
infra/postgres/init.sql          replication role, bucket-storage DB, empty `powersync` publication
infra/powersync/service.yaml     Postgres replication + Postgres bucket storage + JWKS client auth
infra/powersync/sync-config.yaml sync streams (config.edition: 3)
packages/shared                  HLC, fractional ranks, Zod schemas, shared constants
packages/db                      Drizzle schema, migrations (incl. publication), createDb()
apps/api                         Bun + Hono: auth/JWKS, workspaces/members, sync upload
apps/collab                      Bun + Hocuspocus + Redis + Postgres Yjs persistence
apps/web                         React + Vite + PowerSync (OPFS) + TipTap/Yjs
```

## Run locally

Prerequisites: Bun ≥ 1.3, Docker, and a Chromium-based browser or Safari (OPFS is required).

```sh
bun install

# 1. Infra: Postgres 18 on host port 55432, Redis on 6379.
docker compose up -d postgres redis

# 2. Schema and publication.
bun run db:migrate

# 3. API (port 4000). It must be up before PowerSync, which fetches its JWKS.
#    The first run generates an RS256 dev key in apps/api/.keys/.
bun run --filter @sync/api dev

# 4. PowerSync service (port 8080).
docker compose up -d powersync

# 5. Collab server (port 1234) and web app (http://localhost:5180), each in its own terminal.
bun run --filter @sync/collab dev
bun run --filter @sync/web dev
```

`bun run dev` starts api, collab and web together once the infra is up.

### Demo

1. Open the web app in two browser profiles (or one normal and one private window).
2. Pick **Alice** (owner) in one and **Bob** (editor) in the other. The first login seeds the shared "Acme Team" workspace.
3. Type in **Welcome**. You'll see live carets and avatars in both windows.
4. In **Roadmap**, change cells. The change appears instantly in local SQLite and syncs to the other window.
5. Tick **Simulate offline** in one window. This disconnects PowerSync and Hocuspocus. Keep editing in both windows. The top bar shows how many writes are queued. Untick it and both windows reconcile.
6. Switch to **Charlie** (viewer). The UI is read-only and the collab socket is `readOnly`.
7. As Alice, remove Bob under **Members**. Bob's open editor sockets are closed right away.

### Configuration

| Variable | Default | Used by |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:55432/sync_engine` | db, api, collab |
| `REDIS_URL` | `redis://localhost:6379` (set to empty to run without Redis) | api, collab |
| `API_PORT` / `COLLAB_PORT` / `WEB_PORT` | `4000` / `1234` / `5180` | api / collab / web |
| `JWKS_URL` | `http://localhost:4000/api/auth/jwks` | collab |
| `JWT_PRIVATE_JWK` / `JWT_KEY_PATH` | generated into `apps/api/.keys/dev-jwk.json` | api |
| `POSTGRES_PORT` | `55432` | docker compose |
| `VITE_POWERSYNC_URL` / `VITE_COLLAB_URL` | `http://<host>:8080` / `ws://<host>:1234` | web |

## Checks

```sh
bun run typecheck        # tsc in every workspace
bun run build            # api/collab bundles and the Vite production build
bun test                 # HLC, ranks, validation, JWT/JWKS, merge, plus the DB tests below
docker compose config --quiet
```

The cycle-detection, upload-transaction and Yjs-persistence tests run against the migrated Docker Postgres. If it isn't reachable, they are skipped with a warning.
