import { afterAll, describe, expect, test } from "bun:test";
import { nodes, workspaceMembers, workspaces } from "@sync/db";
import { generateKeys, jwks, signToken } from "@sync/api/auth";
import { authorize } from "@sync/collab/auth";
import { packHlc } from "@sync/shared";
import { eq } from "drizzle-orm";
import { createLocalJWKSet } from "jose";
import { isTransientDenial } from "../../web/src/collab.ts";
import { connectTestDb } from "./db.ts";

const db = await connectTestDb();

describe.skipIf(!db)("collab authorize", async () => {
  if (!db) return;
  const keys = await generateKeys("collab-test");
  const verify = createLocalJWKSet(jwks(keys));
  const workspaceId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, name: "collab-auth" });
  await db.insert(workspaceMembers).values({ workspaceId, userId: "alice", role: "viewer" });
  await db.insert(nodes).values({ id: nodeId, workspaceId, rank: "a0", hlcUpdatedAt: packHlc({ ts: 1, counter: 0, node: "t" }) });
  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.$close();
  });
  const denial = (user: string, doc: string) =>
    signToken(keys, user).then(({ token }) => authorize(db, verify, token, doc).then(() => "", (e: { reason: string }) => e.reason));

  test("members get their role", async () => {
    const { token } = await signToken(keys, "alice");
    expect(await authorize(db, verify, token, nodeId)).toEqual({ userId: "alice", workspaceId, role: "viewer" });
  });

  test("unknown page is a transient denial, non-member is permanent", async () => {
    const missing = await denial("alice", crypto.randomUUID());
    const stranger = await denial("mallory", nodeId);
    expect(isTransientDenial(missing)).toBe(true);
    expect(stranger).toContain("forbidden");
    expect(isTransientDenial(stranger)).toBe(false);
    expect(isTransientDenial("access revoked")).toBe(false);
  });
});
