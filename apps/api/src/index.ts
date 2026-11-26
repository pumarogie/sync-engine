import { createDb } from "@sync/db";
import { RedisClient } from "bun";
import { loadOrCreateKeys } from "./auth.ts";
import { createApp } from "./app.ts";
import { pruneProcessedMutations } from "./upload.ts";

const port = Number(process.env.API_PORT ?? 4000);
const keys = await loadOrCreateKeys(process.env.JWT_KEY_PATH ?? new URL("../.keys/dev-jwk.json", import.meta.url).pathname);
const db = createDb();
const redis = process.env.REDIS_URL === "" ? null : new RedisClient(process.env.REDIS_URL ?? "redis://localhost:6379");

const app = createApp({
  db,
  keys,
  publish: async (channel, message) => {
    if (!redis) return console.warn(`[api] REDIS_URL empty; revocation not broadcast: ${message}`);
    return redis.publish(channel, message);
  },
});

const server = Bun.serve({ port, fetch: app.fetch });
console.log(`[api] listening on ${server.url} (jwks kid=${keys.kid})`);

const DAY = 24 * 60 * 60_000;
const prune = () => pruneProcessedMutations(db, 7 * DAY).catch((error) => console.error("[api] prune failed", error));
setInterval(prune, 60 * 60_000).unref();
void prune();
