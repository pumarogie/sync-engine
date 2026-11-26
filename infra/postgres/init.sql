-- Runs once on first container start (docker-entrypoint-initdb.d), as superuser, in sync_engine.

-- Replication role for PowerSync. BYPASSRLS so future RLS policies never hide rows from the replicator.
CREATE ROLE powersync_role WITH REPLICATION BYPASSRLS LOGIN PASSWORD 'powersync_pass';
GRANT USAGE ON SCHEMA public TO powersync_role;
-- Tables are created later by Drizzle migrations (run as postgres); grant SELECT on them up front.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO powersync_role;

-- Publication starts empty; the Drizzle migration adds workspaces, workspace_members, nodes.
CREATE PUBLICATION powersync;

-- Separate database for PowerSync bucket storage (replaces MongoDB).
CREATE ROLE powersync_storage_user WITH LOGIN PASSWORD 'powersync_storage_pass';
CREATE DATABASE powersync_storage OWNER powersync_storage_user;
