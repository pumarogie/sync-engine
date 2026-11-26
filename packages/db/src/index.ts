import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema.ts";

export * from "./schema.ts";
export { schema };

export const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:55432/sync_engine";

export function createDb(url: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  const client = new SQL(url);
  return Object.assign(drizzle({ client, schema }), { $close: () => client.close() });
}

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
