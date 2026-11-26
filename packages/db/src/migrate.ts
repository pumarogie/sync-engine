import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createDb } from "./index.ts";

const db = createDb();
await migrate(db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
await db.$close();
console.log("migrations applied");
