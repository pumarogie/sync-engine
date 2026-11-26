import { HocuspocusProvider } from "@hocuspocus/provider";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { DEMO_USERS, type DemoUserId } from "@sync/shared";
import { usePowerSync } from "@powersync/react";
import type { AbstractPowerSyncDatabase } from "@powersync/web";
import { useEffect, useRef, useState } from "react";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { backoffMs, isTransientDenial, samePeers, type Peer } from "../collab.ts";
import { COLLAB_URL, getToken } from "../data.ts";

const COLORS: Record<DemoUserId, string> = { alice: "#e8590c", bob: "#1c7ed6", charlie: "#2f9e44" };
type Session = { doc: Y.Doc; provider: HocuspocusProvider };

type Props = { nodeId: string; userId: DemoUserId; online: boolean; readOnly: boolean };

export function Editor({ nodeId, userId, online, readOnly }: Props) {
  const db = usePowerSync();
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState("connecting");
  const onlineRef = useRef(online);
  onlineRef.current = online;

  useEffect(() => {
    const doc = new Y.Doc();
    // Local-first: IndexedDB holds the CRDT state, so the page opens and edits offline.
    const local = new IndexeddbPersistence(`yjs:${userId}:${nodeId}`, doc);
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopWatch: (() => void) | undefined;
    // A denied document stays denied on the open socket; re-attaching re-sends the token.
    const reauthenticate = () => {
      clearTimeout(retry);
      if (!onlineRef.current) return;
      provider.detach();
      provider.attach();
    };
    const provider = new HocuspocusProvider({
      url: COLLAB_URL,
      name: nodeId,
      document: doc,
      token: async () => (await getToken(userId)).token,
      onStatus: ({ status }) => setStatus(status),
      onAuthenticated: () => {
        setStatus("connected");
        attempt = 0;
        stopWatch?.();
        stopWatch = undefined;
      },
      onAuthenticationFailed: ({ reason }) => {
        if (!isTransientDenial(reason)) return setStatus(`denied: ${reason}`);
        // Created offline: the server learns about the page once PowerSync uploads it.
        setStatus("waiting for upload");
        retry = setTimeout(reauthenticate, backoffMs(attempt++));
        stopWatch ??= watchUploaded(db, nodeId, reauthenticate);
      },
    });
    provider.awareness?.setLocalStateField("user", { name: DEMO_USERS[userId].name, color: COLORS[userId] });
    setSession({ doc, provider });
    return () => {
      clearTimeout(retry);
      stopWatch?.();
      provider.destroy();
      void local.destroy();
      doc.destroy();
      setSession(null);
    };
  }, [db, nodeId, userId]);

  useEffect(() => {
    if (!session) return;
    if (online) void session.provider.connect();
    else session.provider.disconnect();
  }, [session, online]);

  if (!session) return null;
  return <CollabEditor session={session} userId={userId} readOnly={readOnly} status={online ? status : "offline"} />;
}

function CollabEditor({ session, userId, readOnly, status }: { session: Session; userId: DemoUserId; readOnly: boolean; status: string }) {
  const peers = usePeers(session.provider);
  const editor = useEditor(
    {
      editable: !readOnly,
      extensions: [
        StarterKit.configure({ undoRedo: false }), // Yjs owns undo history
        Collaboration.configure({ document: session.doc }),
        CollaborationCaret.configure({
          provider: session.provider,
          user: { name: DEMO_USERS[userId].name, color: COLORS[userId] },
        }),
      ],
    },
    [session],
  );
  useEffect(() => editor?.setEditable(!readOnly), [editor, readOnly]);

  return (
    <div className="editor">
      <div className="editor-meta">
        <span className={`dot ${status}`} /> {status}
        {readOnly && <span className="badge">read-only</span>}
        <span className="spacer" />
        {peers.map((p) => (
          <span key={p.clientId} className="avatar" style={{ background: p.color }} title={p.name}>
            {p.name[0]}
          </span>
        ))}
      </div>
      <EditorContent editor={editor} className="prose" />
    </div>
  );
}

function usePeers(provider: HocuspocusProvider): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    const awareness = provider.awareness;
    if (!awareness) return;
    // Cursor moves change awareness on every keystroke; only re-render when the peer list changes.
    const update = () => {
      const next = [...awareness.getStates().entries()]
        .filter(([, s]) => s.user)
        .map(([clientId, s]) => ({ clientId, name: s.user.name as string, color: s.user.color as string }));
      setPeers((prev) => (samePeers(prev, next) ? prev : next));
    };
    update();
    awareness.on("change", update);
    return () => awareness.off("change", update);
  }, [provider]);
  return peers;
}

/** Calls `onUploaded` once no queued PowerSync write for `nodeId` remains (after at least one was seen). */
function watchUploaded(db: AbstractPowerSyncDatabase, nodeId: string, onUploaded: () => void): () => void {
  const abort = new AbortController();
  let pending = false;
  db.watch(
    "SELECT count(*) AS n FROM ps_crud WHERE json_extract(data, '$.id') = ?",
    [nodeId],
    {
      onResult: (r) => {
        const n = r.rows?._array[0]?.n ?? 0;
        if (n > 0) pending = true;
        else if (pending) {
          pending = false;
          onUploaded();
        }
      },
    },
    { signal: abort.signal },
  );
  return () => abort.abort();
}
