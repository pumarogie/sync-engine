import { usePowerSync, useQuery } from "@powersync/react";
import { compareRank, DEMO_USERS, rankAfter, rankBetween, ROLES, type DemoUserId, type NodeKind, type Role } from "@sync/shared";
import { useMemo, useState } from "react";
import { api, createNode, deleteNode, getToken, updateNode } from "../data.ts";

type TreeNode = { id: string; parent_id: string | null; kind: NodeKind; title: string; icon: string | null; rank: string };
type Props = {
  userId: DemoUserId;
  workspaces: { id: string; name: string; role: Role }[];
  workspace: { id: string; name: string; role: Role };
  onWorkspace: (id: string) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  canEdit: boolean;
};

const KIND_ICON: Record<NodeKind, string> = { page: "📄", database: "🗂️", db_row: "▫️" };

export function Sidebar(props: Props) {
  const db = usePowerSync();
  const [search, setSearch] = useState("");
  const { data: rows } = useQuery<TreeNode>(
    `SELECT id, parent_id, kind, title, icon, rank FROM nodes
     WHERE workspace_id = ? AND deleted_at IS NULL AND kind != 'db_row'`,
    [props.workspace.id],
  );
  const { data: hits } = useQuery<{ id: string; title: string; kind: NodeKind; plain_text_preview: string | null }>(
    `SELECT id, title, kind, plain_text_preview FROM nodes
     WHERE workspace_id = ? AND deleted_at IS NULL AND ? != '' AND (title LIKE ? OR plain_text_preview LIKE ?)
     ORDER BY title LIMIT 25`,
    [props.workspace.id, search, `%${search}%`, `%${search}%`],
  );

  const children = useMemo(() => {
    const map = new Map<string | null, TreeNode[]>();
    const ids = new Set(rows.map((r) => r.id));
    for (const r of rows) {
      const parent = r.parent_id && ids.has(r.parent_id) ? r.parent_id : null;
      if (r.parent_id && !ids.has(r.parent_id)) continue; // parent tombstoned: hide subtree
      map.set(parent, [...(map.get(parent) ?? []), r]);
    }
    for (const list of map.values()) list.sort(compareRank);
    return map;
  }, [rows]);

  const create = async (parentId: string | null, kind: NodeKind) => {
    const siblings = children.get(parentId) ?? [];
    const id = await createNode(db, {
      workspaceId: props.workspace.id,
      parentId,
      kind,
      rank: rankAfter(siblings.at(-1)?.rank),
      title: kind === "database" ? "Untitled database" : "Untitled",
    });
    props.onSelect(id);
  };

  const move = (node: TreeNode, dir: -1 | 1) => {
    const siblings = children.get(node.parent_id) ?? [];
    const i = siblings.findIndex((s) => s.id === node.id);
    const j = i + dir;
    if (j < 0 || j >= siblings.length) return;
    // Land between the neighbour we jump over and the one beyond it.
    const [a, b] = dir < 0 ? [siblings[j - 1]?.rank, siblings[j]!.rank] : [siblings[j]!.rank, siblings[j + 1]?.rank];
    return updateNode(db, node.id, { rank: rankBetween(a, b) });
  };

  const remove = async (node: TreeNode) => {
    await deleteNode(db, node.id);
    if (props.selected === node.id) props.onSelect(null);
  };

  const renderLevel = (parentId: string | null, depth: number): React.ReactNode =>
    (children.get(parentId) ?? []).map((node) => (
      <div key={node.id}>
        <div
          className={`tree-row ${props.selected === node.id ? "active" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => props.onSelect(node.id)}
        >
          <span className="icon">{node.icon || KIND_ICON[node.kind]}</span>
          <span className="label">{node.title || "Untitled"}</span>
          {props.canEdit && (
            <span className="actions" onClick={(e) => e.stopPropagation()}>
              <button title="Add sub-page" onClick={() => create(node.id, "page")}>＋</button>
              <button title="Move up" onClick={() => move(node, -1)}>↑</button>
              <button title="Move down" onClick={() => move(node, 1)}>↓</button>
              <button title="Delete" onClick={() => remove(node)}>🗑</button>
            </span>
          )}
        </div>
        {renderLevel(node.id, depth + 1)}
      </div>
    ));

  return (
    <aside className="sidebar">
      <select className="ws-select" value={props.workspace.id} onChange={(e) => props.onWorkspace(e.target.value)}>
        {props.workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name} · {w.role}
          </option>
        ))}
      </select>
      <input className="search" placeholder="Search (local SQLite)…" value={search} onChange={(e) => setSearch(e.target.value)} />

      {search ? (
        <div className="tree">
          {hits.length === 0 && <div className="muted pad">No matches</div>}
          {hits.map((h) => (
            <div key={h.id} className="tree-row" onClick={() => props.onSelect(h.id)}>
              <span className="icon">{KIND_ICON[h.kind]}</span>
              <span className="label">
                {h.title || "Untitled"}
                {h.plain_text_preview && <small>{h.plain_text_preview.slice(0, 60)}</small>}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="tree">{renderLevel(null, 0)}</div>
      )}

      {props.canEdit && (
        <div className="sidebar-actions">
          <button onClick={() => create(null, "page")}>＋ New page</button>
          <button onClick={() => create(null, "database")}>＋ New database</button>
        </div>
      )}
      <Members userId={props.userId} workspaceId={props.workspace.id} isOwner={props.workspace.role === "owner"} />
    </aside>
  );
}

function Members({ userId, workspaceId, isOwner }: { userId: DemoUserId; workspaceId: string; isOwner: boolean }) {
  const { data: members } = useQuery<{ user_id: string; role: Role }>(
    "SELECT user_id, role FROM workspace_members WHERE workspace_id = ? ORDER BY created_at",
    [workspaceId],
  );
  const [error, setError] = useState<string | null>(null);
  const call = async (method: string, path: string, body?: unknown) => {
    setError(null);
    try {
      const { token } = await getToken(userId);
      await api(`/api/workspaces/${workspaceId}/members${path}`, { method, body, token });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const missing = (Object.keys(DEMO_USERS) as DemoUserId[]).filter((u) => !members.some((m) => m.user_id === u));

  return (
    <section className="members">
      <h4>Members</h4>
      {members.map((m) => (
        <div key={m.user_id} className="member">
          <span>{DEMO_USERS[m.user_id as DemoUserId]?.name ?? m.user_id}</span>
          {isOwner && m.user_id !== userId ? (
            <>
              <select value={m.role} onChange={(e) => call("POST", "", { userId: m.user_id, role: e.target.value })}>
                {ROLES.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
              <button title="Remove (revokes live editor sessions)" onClick={() => call("DELETE", `/${m.user_id}`)}>
                ✕
              </button>
            </>
          ) : (
            <span className="muted">{m.role}</span>
          )}
        </div>
      ))}
      {isOwner &&
        missing.map((u) => (
          <button key={u} className="link" onClick={() => call("POST", "", { userId: u, role: "editor" })}>
            ＋ Invite {DEMO_USERS[u].name}
          </button>
        ))}
      {error && <div className="error">{error}</div>}
    </section>
  );
}
