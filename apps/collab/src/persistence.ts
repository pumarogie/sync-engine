import { docSnapshots, docUpdates, nodes, type Db, type Tx } from "@sync/db";
import type { Extension, onLoadDocumentPayload, onStoreDocumentPayload } from "@hocuspocus/server";
import { and, asc, count, eq, lte, sql } from "drizzle-orm";
import * as Y from "yjs";

export const COMPACT_AFTER_UPDATES = 25;
const PREVIEW_LENGTH = 280;

/** Flattens the TipTap fragment into plain text, one line per block. */
export function extractPlainText(doc: Y.Doc, field = "default"): string {
  const lines: string[] = [];
  const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment | Y.XmlHook) => {
    if (node instanceof Y.XmlText) {
      const text = (node.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === "string" ? d.insert : "")).join("");
      if (text) lines.push(text);
      return;
    }
    if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) node.toArray().forEach(walk);
  };
  walk(doc.getXmlFragment(field));
  return lines.join("\n");
}

/** Snapshot + subsequent updates, merged into one update. */
export async function fetchDoc(db: Db | Tx, nodeId: string): Promise<Uint8Array | null> {
  const [snapshot] = await db.select().from(docSnapshots).where(eq(docSnapshots.nodeId, nodeId));
  const updates = await db
    .select({ blob: docUpdates.updateBlob })
    .from(docUpdates)
    .where(eq(docUpdates.nodeId, nodeId))
    .orderBy(asc(docUpdates.id));
  const parts = [...(snapshot ? [snapshot.yjsState] : []), ...updates.map((u) => u.blob)].map((b) => new Uint8Array(b));
  return parts.length ? Y.mergeUpdates(parts) : null;
}

/**
 * Appends `delta` to doc_updates, compacts into doc_snapshots past the threshold and mirrors the
 * plain-text preview onto nodes (which PowerSync replicates to every client).
 */
export async function storeDoc(db: Db, nodeId: string, doc: Y.Doc, delta: Uint8Array) {
  await db.transaction(async (tx) => {
    // Serialise writers per document so compaction never races an append.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${nodeId}))`);
    const [{ lastId }] = (await tx
      .insert(docUpdates)
      .values({ nodeId, updateBlob: delta })
      .returning({ lastId: docUpdates.id })) as [{ lastId: number }];

    const [{ pending }] = (await tx.select({ pending: count() }).from(docUpdates).where(eq(docUpdates.nodeId, nodeId))) as [
      { pending: number },
    ];
    if (pending > COMPACT_AFTER_UPDATES) {
      // Compact from what is persisted, not from memory, so updates from other instances are kept.
      const merged = await fetchDoc(tx, nodeId);
      await tx
        .insert(docSnapshots)
        .values({ nodeId, yjsState: merged!, version: 1 })
        .onConflictDoUpdate({
          target: docSnapshots.nodeId,
          set: { yjsState: merged!, version: sql`${docSnapshots.version} + 1`, updatedAt: sql`now()` },
        });
      await tx.delete(docUpdates).where(and(eq(docUpdates.nodeId, nodeId), lte(docUpdates.id, lastId)));
    }

    await tx
      .update(nodes)
      .set({ plainTextPreview: extractPlainText(doc).slice(0, PREVIEW_LENGTH) })
      .where(eq(nodes.id, nodeId));
  });
}

/** Hocuspocus extension: Postgres persistence with append-only deltas and periodic compaction. */
export function postgresPersistence(db: Db): Extension {
  const stored = new WeakMap<Y.Doc, Uint8Array>(); // state vector already persisted per document

  return {
    extensionName: "postgres-persistence",
    async onLoadDocument({ document, documentName }: onLoadDocumentPayload) {
      const state = await fetchDoc(db, documentName);
      if (state) Y.applyUpdate(document, state);
      stored.set(document, Y.encodeStateVector(document));
    },
    async onStoreDocument({ document, documentName }: onStoreDocumentPayload) {
      const before = stored.get(document);
      const delta = Y.encodeStateAsUpdate(document, before);
      const after = Y.encodeStateVector(document);
      // An empty update is 2 bytes (no structs, empty delete set).
      if (delta.byteLength <= 2) return;
      await storeDoc(db, documentName, document, delta);
      stored.set(document, after);
    },
  };
}
