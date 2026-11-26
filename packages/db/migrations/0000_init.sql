CREATE TABLE "doc_snapshots" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"yjs_state" "bytea" NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_updates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"update_blob" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_id" uuid,
	"root_space_id" uuid,
	"kind" text DEFAULT 'page' NOT NULL,
	"rank" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"icon" text,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plain_text_preview" text DEFAULT '' NOT NULL,
	"hlc_updated_at" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_kind_ck" CHECK ("nodes"."kind" in ('page', 'database', 'db_row')),
	CONSTRAINT "nodes_no_self_parent_ck" CHECK ("nodes"."parent_id" is distinct from "nodes"."id")
);
--> statement-breakpoint
CREATE TABLE "processed_mutations" (
	"mutation_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_role_ck" CHECK ("workspace_members"."role" in ('owner', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_snapshots" ADD CONSTRAINT "doc_snapshots_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_updates" ADD CONSTRAINT "doc_updates_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_parent_id_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_updates_node_idx" ON "doc_updates" USING btree ("node_id","id");--> statement-breakpoint
CREATE INDEX "nodes_workspace_idx" ON "nodes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "nodes_parent_idx" ON "nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_workspace_user_uq" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");