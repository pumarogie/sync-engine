import { describe, expect, test } from "bun:test";
import type { Db } from "@sync/db";
import { createApp } from "@sync/api/app";
import { generateKeys, signToken } from "@sync/api/auth";

// These requests are all rejected before touching the database.
const keys = await generateKeys("app-test");
const app = createApp({ db: null as unknown as Db, keys, publish: async () => {} });
const auth = async (user = "alice") => ({ authorization: `Bearer ${(await signToken(keys, user)).token}`, "content-type": "application/json" });

describe("API validation & auth", () => {
  test("GET /api/auth/jwks publishes the public key", async () => {
    const res = await app.request("/api/auth/jwks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: { kid: string; d?: string }[] };
    expect(body.keys[0]!.kid).toBe("app-test");
    expect(body.keys[0]!.d).toBeUndefined();
  });

  test("POST /api/auth/token rejects unknown demo users", async () => {
    const res = await app.request("/api/auth/token", { method: "POST", body: JSON.stringify({ userId: "mallory" }) });
    expect(res.status).toBe(400);
  });

  test("protected routes need a valid bearer token", async () => {
    expect((await app.request("/api/workspaces")).status).toBe(401);
    expect((await app.request("/api/workspaces", { headers: { authorization: "Bearer garbage" } })).status).toBe(401);
    const forged = await signToken(await generateKeys("forged"), "alice");
    expect((await app.request("/api/workspaces", { headers: { authorization: `Bearer ${forged.token}` } })).status).toBe(401);
  });

  test("upload rejects malformed batches with 400", async () => {
    const headers = await auth();
    for (const body of [
      "not json",
      JSON.stringify({}),
      JSON.stringify({ entries: [] }),
      JSON.stringify({ entries: [{ mutationId: "1", op: "PUT", table: "workspace_members", id: crypto.randomUUID(), data: {} }] }),
    ]) {
      const res = await app.request("/api/sync/upload", { method: "POST", headers, body });
      expect(res.status).toBe(400);
    }
  });

  test("workspace routes validate params and bodies", async () => {
    const headers = await auth();
    expect((await app.request("/api/workspaces", { method: "POST", headers, body: JSON.stringify({ name: "  " }) })).status).toBe(400);
    expect((await app.request("/api/workspaces/not-a-uuid/members", { method: "POST", headers, body: "{}" })).status).toBe(400);
    const id = crypto.randomUUID();
    const bad = await app.request(`/api/workspaces/${id}/members`, { method: "POST", headers, body: JSON.stringify({ userId: "bob", role: "admin" }) });
    expect(bad.status).toBe(400);
  });
});
