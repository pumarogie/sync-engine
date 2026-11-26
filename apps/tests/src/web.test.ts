import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { backoffMs, samePeers } from "../../web/src/collab.ts";
import { ftsQuery, SEARCH_OBJECT_COUNT, SEARCH_READY_SQL, SEARCH_SETUP_SQL } from "../../web/src/search.ts";

describe("samePeers", () => {
  const a = { clientId: 1, name: "Alice", color: "#f00" };
  test("equal lists compare equal regardless of identity", () => {
    expect(samePeers([a], [{ ...a }])).toBe(true);
    expect(samePeers([], [])).toBe(true);
  });
  test("any field or length change is a difference", () => {
    expect(samePeers([a], [{ ...a, color: "#0f0" }])).toBe(false);
    expect(samePeers([a], [{ ...a, name: "Bob" }])).toBe(false);
    expect(samePeers([a], [{ ...a, clientId: 2 }])).toBe(false);
    expect(samePeers([a], [a, a])).toBe(false);
  });
});

test("backoff doubles and caps at a minute", () => {
  expect([0, 1, 2, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 60_000]);
});

describe("ftsQuery", () => {
  test("prefix-matches each token", () => {
    expect(ftsQuery("Road map")).toBe('"road"* "map"*');
    expect(ftsQuery("  Café-2026 ")).toBe('"café"* "2026"*');
  });
  test("strips FTS syntax and returns null when nothing is searchable", () => {
    expect(ftsQuery('a" OR title:*')).toBe('"a"* "or"* "title"*');
    expect(ftsQuery("")).toBeNull();
    expect(ftsQuery("  ** \"()")).toBeNull();
  });
});

describe("FTS5 index over ps_data__nodes", () => {
  const db = new Database(":memory:");
  // Same shape PowerSync creates for synced tables.
  db.run("CREATE TABLE ps_data__nodes(id TEXT PRIMARY KEY NOT NULL, data TEXT)");
  const put = (id: string, title: string, preview = "") =>
    db.run("REPLACE INTO ps_data__nodes(id, data) VALUES (?, ?)", [id, JSON.stringify({ title, plain_text_preview: preview })]);
  const search = (q: string) =>
    db.query("SELECT id FROM fts_nodes WHERE fts_nodes MATCH ? ORDER BY id").all(ftsQuery(q)!).map((r) => (r as { id: string }).id);
  put("a", "Roadmap", "quarterly planning");
  for (const statement of SEARCH_SETUP_SQL) db.run(statement);

  test("indexes existing rows and reports ready", () => {
    expect(search("road")).toEqual(["a"]);
    expect((db.query(SEARCH_READY_SQL).get() as { n: number }).n).toBe(SEARCH_OBJECT_COUNT);
  });

  test("REPLACE (how PowerSync syncs) leaves no stale entries", () => {
    put("b", "Groceries");
    put("a", "Budget", "numbers");
    put("a", "Budget 2", "numbers");
    expect(search("road")).toEqual([]);
    expect(search("budget")).toEqual(["a"]);
    expect(search("planning")).toEqual([]);
    expect((db.query("SELECT count(*) AS n FROM fts_nodes").get() as { n: number }).n).toBe(2);
  });

  test("local UPDATE and DELETE stay in sync", () => {
    db.run("UPDATE ps_data__nodes SET data = json_set(data, '$.title', 'Shopping') WHERE id = 'b'");
    expect(search("groc")).toEqual([]);
    expect(search("shop")).toEqual(["b"]);
    db.run("DELETE FROM ps_data__nodes WHERE id = 'b'");
    expect(search("shop")).toEqual([]);
  });
});
