import { afterAll, describe, expect, test } from "bun:test";
import { nodes, processedMutations, workspaceMembers, workspaces } from "@sync/db";
import { connectTestDb } from "./db.ts";
import { packHlc, rankAfter, type CrudEntry } from "@sync/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { applyUpload, wouldCreateCycle } from "@sync/api/upload";

const db = await connectTestDb();
const hlc = (ts: number) => packHlc({ ts, counter: 0, node: "test" });
const workspaceId = crypto.randomUUID();
const otherWorkspaceId = crypto.randomUUID();
const run = crypto.randomUUID().slice(0, 8);
const mid = (n: string) => `${run}:${n}`;

describe.skipIf(!db)("applyUpload against Postgres", async () => {
  if (!db) return;
  await db.insert(workspaces).values([
    { id: workspaceId, name: "test" },
    { id: otherWorkspaceId, name: "other" },
  ]);
  await db.insert(workspaceMembers).values([
    { workspaceId, userId: "alice", role: "owner" },
    { workspaceId, userId: "bob", role: "editor" },
    { workspaceId, userId: "charlie", role: "viewer" },
    { workspaceId: otherWorkspaceId, userId: "alice", role: "owner" },
  ]);
  afterAll(async () => {
    await db.delete(processedMutations).where(inArray(processedMutations.userId, ["alice", "bob", "charlie"]));
    await db.delete(workspaces).where(inArray(workspaces.id, [workspaceId, otherWorkspaceId]));
    await db.$close();
  });

  const put = (id: string, data: Record<string, unknown>, n: string): CrudEntry => ({
    mutationId: mid(n),
    op: "PUT",
    table: "nodes",
    id,
    data: { workspace_id: workspaceId, kind: "page", rank: rankAfter(null), title: "t", hlc_updated_at: hlc(Date.now()), ...data } as CrudEntry["data"],
  });
  const patch = (id: string, data: Record<string, unknown>, n: string, old?: Record<string, unknown>): CrudEntry => ({
    mutationId: mid(n),
    op: "PATCH",
    table: "nodes",
    id,
    data: data as CrudEntry["data"],
    old,
  });
  const get = async (id: string) => (await db.select().from(nodes).where(eq(nodes.id, id)))[0]!;

  const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

  test("creates a tree and derives root_space_id", async () => {
    const res = await applyUpload(db, "alice", [put(a, {}, "a"), put(b, { parent_id: a }, "b"), put(c, { parent_id: b }, "c")]);
    expect(res.applied).toHaveLength(3);
    expect((await get(c)).rootSpaceId).toBe(a);
  });

  test("is idempotent per mutation id", async () => {
    const res = await applyUpload(db, "alice", [put(a, { title: "dup" }, "a")]);
    expect(res).toEqual({ applied: [], skipped: [mid("a")], rejected: [] });
  });

  test("recursive CTE detects cycles", async () => {
    expect(await wouldCreateCycle(db, a, c)).toBe(true); // a -> b -> c, so c cannot parent a
    expect(await wouldCreateCycle(db, a, a)).toBe(true);
    expect(await wouldCreateCycle(db, c, a)).toBe(false);
  });

  test("rejects a move that would create a cycle, keeps the rest of the batch", async () => {
    const res = await applyUpload(db, "bob", [
      patch(a, { parent_id: c, hlc_updated_at: hlc(Date.now()) }, "cycle"),
      patch(b, { title: "renamed", hlc_updated_at: hlc(Date.now()) }, "rename"),
    ]);
    expect(res.rejected).toEqual([{ mutationId: mid("cycle"), reason: expect.stringContaining("cycle") }]);
    expect(res.applied).toEqual([mid("rename")]);
    expect((await get(a)).parentId).toBeNull();
    expect((await get(b)).title).toBe("renamed");
  });

  test("valid move re-roots the subtree", async () => {
    const res = await applyUpload(db, "bob", [patch(b, { parent_id: null, hlc_updated_at: hlc(Date.now()) }, "move")]);
    expect(res.applied).toHaveLength(1);
    expect((await get(b)).rootSpaceId).toBe(b);
    expect((await get(c)).rootSpaceId).toBe(b);
  });

  test("rejects cross-workspace parents", async () => {
    const foreign = crypto.randomUUID();
    await applyUpload(db, "alice", [{ ...put(foreign, { workspace_id: otherWorkspaceId }, "foreign") }]);
    const res = await applyUpload(db, "alice", [patch(c, { parent_id: foreign, hlc_updated_at: hlc(Date.now()) }, "xws")]);
    expect(res.rejected[0]?.reason).toContain("another workspace");
  });

  test("viewers and non-members cannot write", async () => {
    const v = await applyUpload(db, "charlie", [patch(a, { title: "viewer", hlc_updated_at: hlc(Date.now()) }, "viewer")]);
    const s = await applyUpload(db, "stranger", [put(crypto.randomUUID(), {}, "stranger")]);
    expect(v.rejected[0]?.reason).toContain("viewer");
    expect(s.rejected[0]?.reason).toContain("none");
    expect((await get(a)).title).toBe("t");
  });

  test("rejects clocks far in the future", async () => {
    const res = await applyUpload(db, "alice", [patch(a, { title: "future", hlc_updated_at: hlc(Date.now() + 3_600_000) }, "future")]);
    expect(res.rejected[0]?.reason).toContain("future");
  });

  test("concurrent offline edits to different props keys both survive", async () => {
    const row = crypto.randomUUID();
    const t0 = Date.now() - 10_000;
    await applyUpload(db, "alice", [put(row, { kind: "db_row", props: { status: "Todo", priority: "Low" }, hlc_updated_at: hlc(t0) }, "row")]);
    const base = { props: JSON.stringify({ status: "Todo", priority: "Low" }) };
    // Bob edits first (newer clock) but uploads first; Alice's older offline edit to another key arrives later.
    await applyUpload(db, "bob", [patch(row, { props: { status: "Todo", priority: "High" }, hlc_updated_at: hlc(t0 + 200) }, "bob-p"), ], );
    await applyUpload(db, "alice", [patch(row, { props: { status: "Done", priority: "Low" }, hlc_updated_at: hlc(t0 + 100) }, "alice-p", base)]);
    const final = await get(row);
    expect(final.props).toEqual({ status: "Done", priority: "High" });
    expect(final.hlcUpdatedAt).toBe(hlc(t0 + 200));
    // Stored as a real jsonb object (what PowerSync replicates), not a double-encoded JSON string.
    const [{ t }] = (await db.execute(sql`SELECT jsonb_typeof(props) AS t FROM nodes WHERE id = ${row}`)) as unknown as [{ t: string }];
    expect(t).toBe("object");
  });

  test("tombstoning a node tombstones its subtree", async () => {
    const res = await applyUpload(db, "alice", [patch(b, { deleted_at: new Date().toISOString(), hlc_updated_at: hlc(Date.now()) }, "del")]);
    expect(res.applied).toHaveLength(1);
    expect((await get(c)).deletedAt).not.toBeNull();
    expect((await get(a)).deletedAt).toBeNull();
  });
});
