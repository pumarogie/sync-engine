import { nodes, workspaceMembers, workspaces, type Db } from "@sync/db";
import { DEMO_USERS, DEMO_WORKSPACE_ID, packHlc, rankAfter, type DemoUserId, type Role } from "@sync/shared";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { roleIn } from "./upload.ts";

export async function listWorkspaces(db: Db, userId: string) {
  return db
    .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role, createdAt: workspaces.createdAt })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(workspaces.createdAt);
}

export async function createWorkspace(db: Db, userId: string, name: string) {
  return db.transaction(async (tx) => {
    const [ws] = await tx.insert(workspaces).values({ name }).returning();
    await tx.insert(workspaceMembers).values({ workspaceId: ws!.id, userId, role: "owner" });
    return { ...ws!, role: "owner" as const };
  });
}

async function assertOwner(db: Db, workspaceId: string, actorId: string) {
  if ((await roleIn(db, workspaceId, actorId)) !== "owner") throw new HTTPException(403, { message: "owner role required" });
}

/** Adds or re-roles a member. Returns true when an existing membership changed (sessions must re-auth). */
export async function upsertMember(db: Db, actorId: string, workspaceId: string, userId: string, role: Role) {
  await assertOwner(db, workspaceId, actorId);
  const previous = await roleIn(db, workspaceId, userId);
  await db
    .insert(workspaceMembers)
    .values({ workspaceId, userId, role })
    .onConflictDoUpdate({ target: [workspaceMembers.workspaceId, workspaceMembers.userId], set: { role } });
  return { previous, changed: previous !== null && previous !== role };
}

export async function removeMember(db: Db, actorId: string, workspaceId: string, userId: string) {
  await assertOwner(db, workspaceId, actorId);
  if (actorId === userId) throw new HTTPException(400, { message: "owners cannot remove themselves" });
  const removed = await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .returning({ id: workspaceMembers.id });
  return removed.length > 0;
}

/** Idempotent demo seed: shared "Acme" workspace with sample content; each demo user joins with their default role. */
export async function seedDemo(db: Db, userId: DemoUserId) {
  await db.transaction(async (tx) => {
    const created = await tx
      .insert(workspaces)
      .values({ id: DEMO_WORKSPACE_ID, name: "Acme Team" })
      .onConflictDoNothing()
      .returning({ id: workspaces.id });
    await tx
      .insert(workspaceMembers)
      .values({ workspaceId: DEMO_WORKSPACE_ID, userId, role: DEMO_USERS[userId].role })
      .onConflictDoNothing();
    if (created.length === 0) return;

    const hlc = packHlc({ ts: Date.now(), counter: 0, node: "seed" });
    const welcome = crypto.randomUUID();
    const roadmap = crypto.randomUUID();
    const r1 = rankAfter(null);
    const r2 = rankAfter(r1);
    const base = { workspaceId: DEMO_WORKSPACE_ID, hlcUpdatedAt: hlc };
    await tx.insert(nodes).values([
      { ...base, id: welcome, rootSpaceId: welcome, kind: "page", rank: r1, title: "Welcome", icon: "👋" },
      { ...base, id: roadmap, rootSpaceId: roadmap, kind: "database", rank: r2, title: "Roadmap", icon: "🗂️" },
      ...[
        { title: "Offline mode", status: "In progress", priority: "High", assignee: "alice" },
        { title: "Presence cursors", status: "Todo", priority: "Medium", assignee: "bob" },
      ].map(({ title, ...props }, i) => ({
        ...base,
        id: crypto.randomUUID(),
        parentId: roadmap,
        rootSpaceId: roadmap,
        kind: "db_row" as const,
        rank: i === 0 ? r1 : r2,
        title,
        props,
      })),
    ]);
  });
}
