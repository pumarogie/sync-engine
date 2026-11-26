import { describe, expect, test } from "bun:test";
import { crudEntrySchema, packHlc, uploadBatchSchema } from "@sync/shared";

const id = "0190a000-0000-7000-8000-0000000000aa";
const hlc = packHlc({ ts: 1, counter: 0, node: "n" });

describe("upload validation", () => {
  test("accepts a PATCH and parses props JSON from SQLite", () => {
    const parsed = crudEntrySchema.parse({
      mutationId: "c:1",
      op: "PATCH",
      table: "nodes",
      id,
      data: { props: '{"status":"Done"}', hlc_updated_at: hlc },
    });
    expect(parsed.data?.props).toEqual({ status: "Done" });
  });

  test.each([
    ["unknown table", { table: "workspaces" }],
    ["bad id", { id: "not-a-uuid" }],
    ["bad op", { op: "UPSERT" }],
    ["server-only column", { data: { plain_text_preview: "x" } }],
    ["bad HLC", { data: { hlc_updated_at: "yesterday" } }],
    ["bad kind", { data: { kind: "folder" } }],
    ["props not an object", { data: { props: "[1,2]" } }],
  ])("rejects %s", (_, patch) => {
    const entry = { mutationId: "c:1", op: "PATCH", table: "nodes", id, data: { title: "x" }, ...patch };
    expect(crudEntrySchema.safeParse(entry).success).toBe(false);
  });

  test("batch must be non-empty", () => {
    expect(uploadBatchSchema.safeParse({ entries: [] }).success).toBe(false);
  });
});
