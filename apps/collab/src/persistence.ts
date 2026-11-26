import { docSnapshots, docUpdates, nodes, type Db, type Tx } from "@sync/db";
import type { Extension, onLoadDocumentPayload, onStoreDocumentPayload } from "@hocuspocus/server";
import { and, asc, count, desc, eq, lte, sql } from "drizzle-orm";
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

const lock = (nodeId: string) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${nodeId}, 0))`;

/** Folds a document's updates into its snapshot. Only deletes updates it read, so concurrent appends survive. */
export async function compactDoc(db: Db, nodeId: string) {
  await db.transaction(async (tx) => {
    await tx.execute(lock(nodeId));
    const [last] = await tx
      .select({ id: docUpdates.id })
      .from(docUpdates)
      .where(eq(docUpdates.nodeId, nodeId))
      .orderBy(desc(docUpdates.id))
      .limit(1);
    if (!last) return;
    const merged = (await fetchDoc(tx, nodeId))!;
    await tx
      .insert(docSnapshots)
      .values({ nodeId, yjsState: merged, version: 1 })
      .onConflictDoUpdate({
        target: docSnapshots.nodeId,
        set: { yjsState: merged, version: sql`${docSnapshots.version} + 1`, updatedAt: sql`now()` },
      });
    await tx.delete(docUpdates).where(and(eq(docUpdates.nodeId, nodeId), lte(docUpdates.id, last.id)));
  });
}

const compactions = new Map<string, Promise<void>>();

/** Runs at most one compaction per document per process; storeDoc never waits on it. */
function scheduleCompaction(db: Db, nodeId: string) {
  if (compactions.has(nodeId)) return;
  const run = compactDoc(db, nodeId)
    .catch((error) => console.error(`[collab] compaction of ${nodeId} failed`, error))
    .finally(() => compactions.delete(nodeId));
  compactions.set(nodeId, run);
}

/** Waits for scheduled compactions (tests, graceful shutdown). */
export async function drainCompactions() {
  while (compactions.size) await Promise.all(compactions.values());
}

const persistedPreview = new WeakMap<Y.Doc, string>();

/**
 * Appends `delta` to doc_updates and mirrors the plain-text preview onto nodes (which PowerSync
 * replicates to every client) only when it changed. Compaction runs in the background.
 */
export async function storeDoc(db: Db, nodeId: string, doc: Y.Doc, delta: Uint8Array) {
  const preview = extractPlainText(doc).slice(0, PREVIEW_LENGTH);
  const previewChanged = persistedPreview.get(doc) !== preview;
  const pending = await db.transaction(async (tx) => {
    await tx.insert(docUpdates).values({ nodeId, updateBlob: delta });
    if (previewChanged) {
      await tx
        .update(nodes)
        .set({ plainTextPreview: preview })
        .where(and(eq(nodes.id, nodeId), sql`${nodes.plainTextPreview} IS DISTINCT FROM ${preview}`));
    }
    const [{ n }] = (await tx.select({ n: count() }).from(docUpdates).where(eq(docUpdates.nodeId, nodeId))) as [{ n: number }];
    return n;
  });
  persistedPreview.set(doc, preview);
  if (pending > COMPACT_AFTER_UPDATES) scheduleCompaction(db, nodeId);
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
