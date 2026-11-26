import { Redis } from "@hocuspocus/extension-redis";
import { Hocuspocus, type Extension } from "@hocuspocus/server";
import { createDb } from "@sync/db";
import { REVOKE_CHANNEL, revokeMessageSchema, type RevokeMessage } from "@sync/shared";
import { RedisClient } from "bun";
import { authorize, remoteKeys, type CollabContext } from "./auth.ts";
import { postgresPersistence } from "./persistence.ts";

const port = Number(process.env.COLLAB_PORT ?? 1234);
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const db = createDb();
const keys = remoteKeys(process.env.JWKS_URL ?? "http://localhost:4000/api/auth/jwks");

const extensions: Extension[] = [postgresPersistence(db)];
if (redisUrl) {
  const url = new URL(redisUrl);
  extensions.push(
    new Redis({ host: url.hostname, port: Number(url.port || 6379), options: { password: url.password || undefined } }),
  );
} else {
  console.warn("[collab] REDIS_URL empty: running single-instance without Redis fan-out or revocation");
}

export function revokeConnections(instance: Hocuspocus<CollabContext>, { userId, workspaceId }: RevokeMessage): number {
  let closed = 0;
  for (const document of instance.documents.values()) {
    for (const connection of document.getConnections()) {
      const ctx = connection.context as CollabContext;
      if (ctx.userId === userId && ctx.workspaceId === workspaceId) {
        connection.close({ code: 4403, reason: "access revoked" });
        closed++;
      }
    }
  }
  return closed;
}

const hocuspocus = new Hocuspocus<CollabContext>({
  name: "collab",
  debounce: 2000,
  maxDebounce: 10000,
  extensions,
  async onAuthenticate({ token, documentName, connectionConfig }) {
    const context = await authorize(db, keys, token, documentName);
    connectionConfig.readOnly = context.role === "viewer";
    return context;
  },
});

// Hocuspocus' bundled Server uses the crossws Node adapter, which refuses to run on Bun,
// so wire Hocuspocus straight into Bun's native WebSocket server instead.
type Socket = { request: Request; connection?: ReturnType<Hocuspocus<CollabContext>["handleConnection"]> };
const server = Bun.serve<Socket>({
  port,
  fetch(request, server) {
    if (server.upgrade(request, { data: { request } })) return;
    return new Response("collab ok");
  },
  websocket: {
    open(ws) {
      ws.data.connection = hocuspocus.handleConnection(ws, ws.data.request);
    },
    message(ws, message) {
      ws.data.connection?.handleMessage(typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message));
    },
    pong(ws) {
      ws.data.connection?.touch();
    },
    close(ws, code, reason) {
      ws.data.connection?.handleClose({ code, reason });
    },
  },
});
console.log(`[collab] listening on ws://localhost:${server.port}`);

if (redisUrl) {
  const subscriber = new RedisClient(redisUrl);
  await subscriber.subscribe(REVOKE_CHANNEL, (raw) => {
    const parsed = revokeMessageSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return console.warn("[collab] bad revoke message", raw);
    const closed = revokeConnections(hocuspocus, parsed.data);
    console.log(`[collab] revoked ${parsed.data.userId} in ${parsed.data.workspaceId}: closed ${closed} connection(s)`);
  });
}
