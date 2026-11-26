import { sql } from "drizzle-orm";
import { createDb, type Db } from "@sync/db";

/** Connects to the migrated dev/test database, or returns null so DB tests can skip. */
export async function connectTestDb(): Promise<Db | null> {
  const db = createDb(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);
  try {
    await db.execute(sql`SELECT 1 FROM nodes LIMIT 1`);
    return db;
  } catch {
    console.warn("[test] Postgres not reachable or not migrated; skipping DB tests (run `docker compose up -d postgres && bun run db:migrate`).");
    await db.$close();
    return null;
  }
}
