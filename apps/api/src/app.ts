import type { Db } from "@sync/db";
import {
  addMemberSchema,
  createWorkspaceSchema,
  REVOKE_CHANNEL,
  tokenRequestSchema,
  uploadBatchSchema,
  type RevokeMessage,
} from "@sync/shared";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { jwks, signToken, verifyToken, type Keys } from "./auth.ts";
import { applyUpload } from "./upload.ts";
import { createWorkspace, listWorkspaces, removeMember, seedDemo, upsertMember } from "./workspaces.ts";

export type AppDeps = {
  db: Db;
  keys: Keys;
  publish: (channel: string, message: string) => Promise<unknown>;
};

type Env = { Variables: { userId: string } };

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) });
  return parsed.data;
}

const uuidParam = z.uuid();
function workspaceId(c: Context): string {
  const parsed = uuidParam.safeParse(c.req.param("id"));
  if (!parsed.success) throw new HTTPException(400, { message: "invalid workspace id" });
  return parsed.data;
}

export function createApp({ db, keys, publish }: AppDeps) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/auth/jwks", (c) => c.json(jwks(keys)));

  app.post("/api/auth/token", async (c) => {
    const { userId } = await body(c, tokenRequestSchema);
    await seedDemo(db, userId);
    return c.json(await signToken(keys, userId));
  });

  const authed = new Hono<Env>();
  authed.use(async (c, next) => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw new HTTPException(401, { message: "missing bearer token" });
    const userId = await verifyToken(keys, token).catch(() => {
      throw new HTTPException(401, { message: "invalid token" });
    });
    c.set("userId", userId);
    await next();
  });

  authed.get("/workspaces", async (c) => c.json(await listWorkspaces(db, c.get("userId"))));

  authed.post("/workspaces", async (c) => {
    const { name } = await body(c, createWorkspaceSchema);
    return c.json(await createWorkspace(db, c.get("userId"), name), 201);
  });

  const revoke = (message: RevokeMessage) => publish(REVOKE_CHANNEL, JSON.stringify(message));

  authed.post("/workspaces/:id/members", async (c) => {
    const id = workspaceId(c);
    const { userId, role } = await body(c, addMemberSchema);
    const { changed } = await upsertMember(db, c.get("userId"), id, userId, role);
    // A role change must drop open editor sockets so they re-authenticate with the new role.
    if (changed) await revoke({ userId, workspaceId: id });
    return c.json({ workspaceId: id, userId, role }, 201);
  });

  authed.delete("/workspaces/:id/members/:userId", async (c) => {
    const id = workspaceId(c);
    const userId = c.req.param("userId");
    if (!(await removeMember(db, c.get("userId"), id, userId))) throw new HTTPException(404, { message: "member not found" });
    await revoke({ userId, workspaceId: id });
    return c.body(null, 204);
  });

  authed.post("/sync/upload", async (c) => {
    const { entries } = await body(c, uploadBatchSchema);
    return c.json(await applyUpload(db, c.get("userId"), entries));
  });

  app.route("/api", authed);
  return app;
}
