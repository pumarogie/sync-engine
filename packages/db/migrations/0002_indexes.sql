CREATE INDEX "nodes_workspace_kind_live_idx" ON "nodes" USING btree ("workspace_id","kind") WHERE "nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "nodes_root_space_live_idx" ON "nodes" USING btree ("root_space_id") WHERE "nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "processed_mutations_processed_at_idx" ON "processed_mutations" USING btree ("processed_at");