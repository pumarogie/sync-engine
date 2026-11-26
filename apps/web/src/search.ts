// Local full-text search: an FTS5 index over PowerSync's raw `ps_data__nodes` table, kept in sync by
// triggers. PowerSync's sync applies rows with `REPLACE INTO`, which drops the old row without firing
// DELETE triggers, so the old index entry is removed in a BEFORE INSERT trigger instead.
const title = "json_extract(NEW.data, '$.title')";
const preview = "json_extract(NEW.data, '$.plain_text_preview')";

export const SEARCH_SETUP_SQL = [
  "DROP TABLE IF EXISTS fts_nodes",
  "CREATE VIRTUAL TABLE fts_nodes USING fts5(id UNINDEXED, title, preview, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')",
  `INSERT INTO fts_nodes(rowid, id, title, preview)
     SELECT rowid, id, json_extract(data, '$.title'), json_extract(data, '$.plain_text_preview') FROM ps_data__nodes`,
  `CREATE TRIGGER IF NOT EXISTS fts_nodes_bi BEFORE INSERT ON ps_data__nodes BEGIN
     DELETE FROM fts_nodes WHERE rowid = (SELECT rowid FROM ps_data__nodes WHERE id = NEW.id);
   END`,
  `CREATE TRIGGER IF NOT EXISTS fts_nodes_ai AFTER INSERT ON ps_data__nodes BEGIN
     INSERT INTO fts_nodes(rowid, id, title, preview) VALUES (NEW.rowid, NEW.id, ${title}, ${preview});
   END`,
  `CREATE TRIGGER IF NOT EXISTS fts_nodes_au AFTER UPDATE ON ps_data__nodes BEGIN
     DELETE FROM fts_nodes WHERE rowid = OLD.rowid;
     INSERT INTO fts_nodes(rowid, id, title, preview) VALUES (NEW.rowid, NEW.id, ${title}, ${preview});
   END`,
  `CREATE TRIGGER IF NOT EXISTS fts_nodes_ad AFTER DELETE ON ps_data__nodes BEGIN
     DELETE FROM fts_nodes WHERE rowid = OLD.rowid;
   END`,
];

/** True when the index and all its triggers exist (they vanish if PowerSync recreates the table). */
export const SEARCH_READY_SQL =
  "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('fts_nodes', 'fts_nodes_bi', 'fts_nodes_ai', 'fts_nodes_au', 'fts_nodes_ad')";
export const SEARCH_OBJECT_COUNT = 5;

/** Turns user input into an FTS5 prefix query (`"foo"* "bar"*`), or null when nothing is searchable. */
export function ftsQuery(input: string): string | null {
  const tokens = input.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return tokens ? tokens.map((t) => `"${t}"*`).join(" ") : null;
}
