import { afterAll, describe, expect, test } from "bun:test";
import { docSnapshots, docUpdates, nodes, workspaces } from "@sync/db";
import { connectTestDb } from "./db.ts";
import { packHlc } from "@sync/shared";
import { count, eq } from "drizzle-orm";
import * as Y from "yjs";
import { COMPACT_AFTER_UPDATES, extractPlainText, fetchDoc, storeDoc } from "@sync/collab/persistence";

function paragraph(doc: Y.Doc, text: string) {
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  const frag = doc.getXmlFragment("default");
  frag.insert(frag.length, [p]);
}

test("extractPlainText flattens TipTap blocks", () => {
  const doc = new Y.Doc();
  paragraph(doc, "Hello");
  const list = new Y.XmlElement("bulletList");
  const item = new Y.XmlElement("listItem");
  const inner = new Y.XmlElement("paragraph");
  inner.insert(0, [new Y.XmlText("nested item")]);
  item.insert(0, [inner]);
  list.insert(0, [item]);
  doc.getXmlFragment("default").insert(1, [list]);
  expect(extractPlainText(doc)).toBe("Hello\nnested item");
});

const db = await connectTestDb();

describe.skipIf(!db)("Postgres Yjs persistence", async () => {
  if (!db) return;
  const workspaceId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, name: "collab-test" });
  await db.insert(nodes).values({ id: nodeId, workspaceId, rank: "a0", hlcUpdatedAt: packHlc({ ts: 1, counter: 0, node: "t" }) });
  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.$close();
  });

  test("appends deltas, compacts past the threshold and reloads identical state", async () => {
    const doc = new Y.Doc();
    let sv = Y.encodeStateVector(doc);
    for (let i = 0; i <= COMPACT_AFTER_UPDATES + 2; i++) {
      paragraph(doc, `line ${i}`);
      const delta = Y.encodeStateAsUpdate(doc, sv);
      sv = Y.encodeStateVector(doc);
      await storeDoc(db, nodeId, doc, delta);
    }
    const [snapshot] = await db.select().from(docSnapshots).where(eq(docSnapshots.nodeId, nodeId));
    const [{ n }] = (await db.select({ n: count() }).from(docUpdates).where(eq(docUpdates.nodeId, nodeId))) as [{ n: number }];
    expect(snapshot?.version).toBe(1);
    expect(n).toBeLessThan(COMPACT_AFTER_UPDATES);

    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, (await fetchDoc(db, nodeId))!);
    expect(extractPlainText(reloaded)).toBe(extractPlainText(doc));

    const [row] = await db.select({ preview: nodes.plainTextPreview }).from(nodes).where(eq(nodes.id, nodeId));
    expect(row?.preview.startsWith("line 0\nline 1")).toBe(true);
  });

  test("unknown documents load as empty", async () => {
    expect(await fetchDoc(db, crypto.randomUUID())).toBeNull();
  });
});
