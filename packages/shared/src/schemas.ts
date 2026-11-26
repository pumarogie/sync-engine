import { z } from "zod";
import { isHlc } from "./hlc.ts";

export const ROLES = ["owner", "editor", "viewer"] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const NODE_KINDS = ["page", "database", "db_row"] as const;
export const nodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof nodeKindSchema>;

export const DEMO_USERS = {
  alice: { name: "Alice", role: "owner" },
  bob: { name: "Bob", role: "editor" },
  charlie: { name: "Charlie", role: "viewer" },
} as const satisfies Record<string, { name: string; role: Role }>;
export type DemoUserId = keyof typeof DEMO_USERS;

// Auth
export const tokenRequestSchema = z.object({ userId: z.enum(Object.keys(DEMO_USERS) as [DemoUserId, ...DemoUserId[]]) });
export const tokenResponseSchema = z.object({ token: z.string(), userId: z.string(), expiresAt: z.number() });
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

// Workspaces
export const createWorkspaceSchema = z.object({ name: z.string().trim().min(1).max(100) });
export const addMemberSchema = z.object({ userId: z.string().trim().min(1).max(100), role: roleSchema });

// PowerSync upload. `props` arrives as a JSON string from local SQLite.
const jsonObject = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  },
  z.record(z.string(), z.unknown()),
);
const hlcSchema = z.string().refine(isHlc, "invalid HLC");

export const nodeFieldsSchema = z
  .object({
    workspace_id: z.uuid(),
    parent_id: z.uuid().nullable(),
    kind: nodeKindSchema,
    rank: z.string().min(1).max(256),
    title: z.string().max(500),
    icon: z.string().max(32).nullable(),
    props: jsonObject,
    hlc_updated_at: hlcSchema,
    deleted_at: z.string().nullable(),
  })
  .partial()
  .strict();
export type NodeFields = z.infer<typeof nodeFieldsSchema>;

export const crudEntrySchema = z.object({
  mutationId: z.string().min(1).max(200),
  op: z.enum(["PUT", "PATCH", "DELETE"]),
  table: z.literal("nodes"),
  id: z.uuid(),
  data: nodeFieldsSchema.optional(),
  /** Previous column values (PowerSync trackPrevious) - the base for the three-way merge. */
  old: z.record(z.string(), z.unknown()).optional(),
});
export type CrudEntry = z.infer<typeof crudEntrySchema>;

export const uploadBatchSchema = z.object({ entries: z.array(crudEntrySchema).min(1).max(1000) });
export type UploadBatch = z.infer<typeof uploadBatchSchema>;

export type UploadResult = {
  applied: string[];
  skipped: string[];
  rejected: { mutationId: string; reason: string }[];
};

export const REVOKE_CHANNEL = "collab:revoke";
export const revokeMessageSchema = z.object({ userId: z.string(), workspaceId: z.string() });
export type RevokeMessage = z.infer<typeof revokeMessageSchema>;

export const JWT_AUDIENCE = "powersync";
export const JWT_ISSUER = "sync-engine-api";
export const DEMO_WORKSPACE_ID = "0190a000-0000-7000-8000-000000000001";
