import { nodes, processedMutations, workspaceMembers, type Db, type Tx } from "@sync/db";
import { packHlc, parseHlc, type CrudEntry, type Role, type UploadResult } from "@sync/shared";
import { and, eq, sql } from "drizzle-orm";
import { mergeNode, type NodeState } from "./merge.ts";

const MAX_CLOCK_DRIFT_MS = 5 * 60_000;
const WRITE_ROLES: Role[] = ["owner", "editor"];

export class Rejection extends Error {}

export async function roleIn(tx: Tx | Db, workspaceId: string, userId: string): Promise<Role | null> {
  const [row] = await tx
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return row?.role ?? null;
}

async function assertCanWrite(tx: Tx, workspaceId: string, userId: string) {
  const role = await roleIn(tx, workspaceId, userId);
  if (!role || !WRITE_ROLES.includes(role)) throw new Rejection(`role ${role ?? "none"} cannot write workspace ${workspaceId}`);
}

/** True when making `newParentId` the parent of `nodeId` would close a loop (walks ancestors of the new parent). */
export async function wouldCreateCycle(tx: Tx | Db, nodeId: string, newParentId: string): Promise<boolean> {
  if (nodeId === newParentId) return true;
  const rows = await tx.execute<{ hit: number }>(sql`
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_id FROM nodes WHERE id = ${newParentId}
      UNION
      SELECT n.id, n.parent_id FROM nodes n JOIN ancestors a ON n.id = a.parent_id
    )
    SELECT 1 AS hit FROM ancestors WHERE id = ${nodeId} LIMIT 1`);
  return rows.length > 0;
}

/** Validates a new parent and returns the root_space_id its children inherit. */
async function resolveParent(tx: Tx, nodeId: string, workspaceId: string, parentId: string | null): Promise<string> {
  if (parentId === null) return nodeId;
  const [parent] = await tx
    .select({ workspaceId: nodes.workspaceId, rootSpaceId: nodes.rootSpaceId })
    .from(nodes)
    .where(eq(nodes.id, parentId));
  if (!parent) throw new Rejection(`parent ${parentId} not found`);
  if (parent.workspaceId !== workspaceId) throw new Rejection("parent belongs to another workspace");
  if (await wouldCreateCycle(tx, nodeId, parentId)) throw new Rejection(`moving ${nodeId} under ${parentId} creates a cycle`);
  return parent.rootSpaceId ?? parentId;
}

function subtree(nodeId: string) {
  return sql`WITH RECURSIVE subtree(id) AS (
    SELECT ${nodeId}::uuid UNION SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
  )`;
}

function assertClock(hlc: string | undefined, now: number): string {
  if (!hlc) throw new Rejection("hlc_updated_at is required");
  if (parseHlc(hlc).ts - now > MAX_CLOCK_DRIFT_MS) throw new Rejection("hlc_updated_at is too far in the future");
  return hlc;
}

async function applyEntry(tx: Tx, userId: string, entry: CrudEntry, now: number) {
  const [current] = await tx.select().from(nodes).where(eq(nodes.id, entry.id)).for("update");
  const data = entry.data ?? {};

  if (entry.op === "DELETE") {
    if (!current) return;
    await assertCanWrite(tx, current.workspaceId, userId);
    const hlc = packHlc({ ts: now, counter: 0, node: "server" });
    await tx.execute(sql`${subtree(entry.id)}
      UPDATE nodes SET deleted_at = now(), hlc_updated_at = ${hlc}, updated_at = now()
      WHERE id IN (SELECT id FROM subtree) AND deleted_at IS NULL`);
    return;
  }

  const hlc = assertClock(data.hlc_updated_at, now);

  if (!current) {
    if (entry.op === "PATCH") throw new Rejection(`node ${entry.id} not found`);
    if (!data.workspace_id || !data.rank) throw new Rejection("workspace_id and rank are required");
    await assertCanWrite(tx, data.workspace_id, userId);
    const parentId = data.parent_id ?? null;
    const rootSpaceId = await resolveParent(tx, entry.id, data.workspace_id, parentId);
    await tx.insert(nodes).values({
      id: entry.id,
      workspaceId: data.workspace_id,
      parentId,
      rootSpaceId,
      kind: data.kind ?? "page",
      rank: data.rank,
      title: data.title ?? "",
      icon: data.icon ?? null,
      props: data.props ?? {},
      hlcUpdatedAt: hlc,
      deletedAt: data.deleted_at ?? null,
    });
    return;
  }

  await assertCanWrite(tx, current.workspaceId, userId);
  if (data.workspace_id && data.workspace_id !== current.workspaceId) throw new Rejection("workspace_id is immutable");

  const state: NodeState = {
    parent_id: current.parentId,
    kind: current.kind,
    rank: current.rank,
    title: current.title,
    icon: current.icon,
    props: current.props,
    deleted_at: current.deletedAt,
    hlc_updated_at: current.hlcUpdatedAt,
  };
  const { changes, hlc: mergedHlc } = mergeNode(state, data, entry.old);
  if (Object.keys(changes).length === 0) return;

  if (changes.parent_id !== undefined) {
    const rootSpaceId = await resolveParent(tx, entry.id, current.workspaceId, changes.parent_id);
    await tx.execute(sql`${subtree(entry.id)}
      UPDATE nodes SET root_space_id = ${rootSpaceId} WHERE id IN (SELECT id FROM subtree)`);
  }

  await tx
    .update(nodes)
    .set({
      ...(changes.parent_id !== undefined && { parentId: changes.parent_id }),
      ...(changes.kind !== undefined && { kind: changes.kind }),
      ...(changes.rank !== undefined && { rank: changes.rank }),
      ...(changes.title !== undefined && { title: changes.title }),
      ...(changes.icon !== undefined && { icon: changes.icon }),
      ...(changes.props !== undefined && { props: changes.props }),
      ...(changes.deleted_at !== undefined && { deletedAt: changes.deleted_at }),
      hlcUpdatedAt: mergedHlc,
      updatedAt: new Date(now),
    })
    .where(eq(nodes.id, entry.id));

  if (changes.deleted_at) {
    await tx.execute(sql`${subtree(entry.id)}
      UPDATE nodes SET deleted_at = ${changes.deleted_at}, hlc_updated_at = ${mergedHlc}, updated_at = now()
      WHERE id IN (SELECT id FROM subtree) AND deleted_at IS NULL`);
  }
}

/**
 * Applies a PowerSync upload batch in one transaction. Each entry runs in a savepoint: a rejected
 * entry (permissions, cycle, validation) is rolled back and reported, but still recorded in
 * processed_mutations so retries stay idempotent. PowerSync then syncs the authoritative row back.
 */
export async function applyUpload(db: Db, userId: string, entries: CrudEntry[], now = Date.now()): Promise<UploadResult> {
  const result: UploadResult = { applied: [], skipped: [], rejected: [] };
  await db.transaction(async (tx) => {
    for (const entry of entries) {
      const claimed = await tx
        .insert(processedMutations)
        .values({ mutationId: entry.mutationId, userId })
        .onConflictDoNothing()
        .returning({ id: processedMutations.mutationId });
      if (claimed.length === 0) {
        result.skipped.push(entry.mutationId);
        continue;
      }
      try {
        await tx.transaction((sp) => applyEntry(sp, userId, entry, now));
        result.applied.push(entry.mutationId);
      } catch (error) {
        if (!(error instanceof Rejection)) throw error;
        result.rejected.push({ mutationId: entry.mutationId, reason: error.message });
      }
    }
  });
  return result;
}
