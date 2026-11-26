import { PowerSyncContext, useQuery, useStatus } from "@powersync/react";
import type { PowerSyncDatabase } from "@powersync/web";
import { DEMO_USERS, type DemoUserId, type Role } from "@sync/shared";
import { useEffect, useState } from "react";
import { PageView } from "./components/PageView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Connector, openDatabase } from "./data.ts";

const USER_IDS = Object.keys(DEMO_USERS) as DemoUserId[];
const databases = new Map<DemoUserId, PowerSyncDatabase>();

function databaseFor(userId: DemoUserId) {
  let db = databases.get(userId);
  if (!db) databases.set(userId, (db = openDatabase(userId)));
  return db;
}

export type SessionProps = { userId: DemoUserId; online: boolean };

export function App() {
  const [userId, setUserId] = useState<DemoUserId>(() => {
    const saved = localStorage.getItem("user") as DemoUserId | null;
    return saved && saved in DEMO_USERS ? saved : "alice";
  });
  const [online, setOnline] = useState(true);
  const db = databaseFor(userId);

  useEffect(() => {
    localStorage.setItem("user", userId);
    if (online) db.connect(new Connector(userId));
    return () => void db.disconnect();
  }, [db, userId, online]);

  return (
    <PowerSyncContext.Provider value={db}>
      <div className="app">
        <TopBar userId={userId} onUser={setUserId} online={online} onOnline={setOnline} />
        <Workspace key={userId} userId={userId} online={online} />
      </div>
    </PowerSyncContext.Provider>
  );
}

function TopBar(props: { userId: DemoUserId; onUser: (u: DemoUserId) => void; online: boolean; onOnline: (o: boolean) => void }) {
  const status = useStatus();
  const { data: pending } = useQuery<{ n: number }>("SELECT count(*) AS n FROM ps_crud");
  const queued = pending[0]?.n ?? 0;
  const busy = status.dataFlowStatus.uploading || status.dataFlowStatus.downloading;
  const label = !props.online ? "Offline (simulated)" : !status.connected ? "Connecting…" : busy ? "Syncing…" : "Synced";
  const tone = !props.online ? "off" : status.connected ? (busy ? "busy" : "ok") : "busy";

  return (
    <header className="topbar">
      <strong className="brand">◆ Sync Engine</strong>
      <span className={`pill ${tone}`} title={status.lastSyncedAt ? `Last synced ${status.lastSyncedAt.toLocaleTimeString()}` : undefined}>
        <i /> {label}
        {queued > 0 && <em>{queued} queued</em>}
      </span>
      <div className="spacer" />
      <label className="toggle">
        <input type="checkbox" checked={!props.online} onChange={(e) => props.onOnline(!e.target.checked)} />
        Simulate offline
      </label>
      <select value={props.userId} onChange={(e) => props.onUser(e.target.value as DemoUserId)} aria-label="Current user">
        {USER_IDS.map((id) => (
          <option key={id} value={id}>
            {DEMO_USERS[id].name} ({DEMO_USERS[id].role})
          </option>
        ))}
      </select>
    </header>
  );
}

function Workspace({ userId, online }: SessionProps) {
  const { data: workspaces, isLoading } = useQuery<{ id: string; name: string; role: Role }>(
    `SELECT w.id, w.name, m.role FROM workspaces w
     JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
     ORDER BY w.created_at`,
    [userId],
  );
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(() => location.hash.slice(1) || null);
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];

  useEffect(() => {
    const onHash = () => setNodeId(location.hash.slice(1) || null);
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const open = (id: string | null) => {
    history.replaceState(null, "", id ? `#${id}` : location.pathname);
    setNodeId(id);
  };

  if (!workspace) {
    return <main className="empty">{isLoading || !online ? "Loading local database…" : "Waiting for first sync…"}</main>;
  }
  const canEdit = workspace.role !== "viewer";
  return (
    <div className="body">
      <Sidebar
        userId={userId}
        workspaces={workspaces}
        workspace={workspace}
        onWorkspace={setWorkspaceId}
        selected={nodeId}
        onSelect={open}
        canEdit={canEdit}
      />
      <main className="main">
        {nodeId ? (
          <PageView key={nodeId} nodeId={nodeId} userId={userId} online={online} canEdit={canEdit} onSelect={open} />
        ) : (
          <div className="empty">Select or create a page.</div>
        )}
      </main>
    </div>
  );
}
