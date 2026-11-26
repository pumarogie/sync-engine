import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });

// Bun SQL JSON-encodes jsonb parameters itself; drizzle's built-in jsonb would stringify first and
// store a JSON *string* instead of an object.
const jsonb = <T>(name: string) =>
  customType<{ data: T; driverData: unknown }>({
    dataType: () => "jsonb",
    toDriver: (value) => value,
    fromDriver: (value) => (typeof value === "string" ? JSON.parse(value) : value) as T,
  })(name);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// Synced tables use a single uuid `id` primary key (PowerSync requirement). Postgres 18 uuidv7()
// is the default; clients may supply their own ids for offline creates.
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["owner", "editor", "viewer"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("workspace_members_workspace_user_uq").on(t.workspaceId, t.userId),
    index("workspace_members_user_idx").on(t.userId),
    check("workspace_members_role_ck", sql`${t.role} in ('owner', 'editor', 'viewer')`),
  ],
);

export const nodes = pgTable(
  "nodes",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => nodes.id, { onDelete: "set null" }),
    rootSpaceId: uuid("root_space_id"),
    kind: text("kind", { enum: ["page", "database", "db_row"] }).notNull().default("page"),
    rank: text("rank").notNull(),
    title: text("title").notNull().default(""),
    icon: text("icon"),
    props: jsonb<Record<string, unknown>>("props").notNull().default({}),
    plainTextPreview: text("plain_text_preview").notNull().default(""),
    hlcUpdatedAt: text("hlc_updated_at").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("nodes_workspace_idx").on(t.workspaceId),
    index("nodes_parent_idx").on(t.parentId),
    check("nodes_kind_ck", sql`${t.kind} in ('page', 'database', 'db_row')`),
    check("nodes_no_self_parent_ck", sql`${t.parentId} is distinct from ${t.id}`),
  ],
);

export const docSnapshots = pgTable("doc_snapshots", {
  nodeId: uuid("node_id")
    .primaryKey()
    .references(() => nodes.id, { onDelete: "cascade" }),
  yjsState: bytea("yjs_state").notNull(),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const docUpdates = pgTable(
  "doc_updates",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    updateBlob: bytea("update_blob").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("doc_updates_node_idx").on(t.nodeId, t.id)],
);

export const processedMutations = pgTable("processed_mutations", {
  mutationId: text("mutation_id").primaryKey(),
  userId: text("user_id").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Node = typeof nodes.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
