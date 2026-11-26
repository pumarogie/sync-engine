-- Synced tables for PowerSync logical replication. The publication and powersync_role come from
-- infra/postgres/init.sql; guarded so the migration also runs on a database without them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync') THEN
    CREATE PUBLICATION powersync;
  END IF;
  ALTER PUBLICATION powersync SET TABLE workspaces, workspace_members, nodes;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync_role') THEN
    GRANT SELECT ON workspaces, workspace_members, nodes TO powersync_role;
  END IF;
END
$$;
