import { usePowerSync, useQuery } from "@powersync/react";
import { compareRank, DEMO_USERS, rankAfter, type DemoUserId } from "@sync/shared";
import { useEffect, useRef, useState } from "react";
import { createNode, deleteNode, setProp, updateNode, type NodeRow } from "../data.ts";
import { Editor } from "./Editor.tsx";

type Props = { nodeId: string; userId: DemoUserId; online: boolean; canEdit: boolean; onSelect: (id: string) => void };
type Node = NodeRow & { id: string };

export function PageView({ nodeId, userId, online, canEdit, onSelect }: Props) {
  const db = usePowerSync();
  const { data, isLoading } = useQuery<Node>("SELECT * FROM nodes WHERE id = ?", [nodeId]);
  const node = data[0];
  if (!node) return <div className="empty">{isLoading ? "Loading…" : "Page not found (it may not have synced yet)."}</div>;
  if (node.deleted_at) return <div className="empty">This page was deleted.</div>;

  return (
    <article className="page">
      <header className="page-header">
        <TextField
          className="page-icon"
          value={node.icon ?? ""}
          placeholder="📄"
          disabled={!canEdit}
          onCommit={(icon) => updateNode(db, node.id, { icon: icon || null })}
        />
        <TextField
          className="page-title"
          value={node.title ?? ""}
          placeholder="Untitled"
          disabled={!canEdit}
          onCommit={(title) => updateNode(db, node.id, { title })}
        />
      </header>
      {node.kind === "database" ? (
        <DatabaseView databaseId={node.id} workspaceId={node.workspace_id!} canEdit={canEdit} onSelect={onSelect} />
      ) : (
        <Editor key={`${userId}:${node.id}`} nodeId={node.id} userId={userId} online={online} readOnly={!canEdit} />
      )}
    </article>
  );
}

/** Input that keeps local state while typing and writes to SQLite after a short pause. */
function TextField(props: { value: string; placeholder: string; disabled: boolean; className?: string; onCommit: (v: string) => unknown }) {
  const [draft, setDraft] = useState(props.value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(props.value);
  }, [props.value]);
  const commit = (v: string) => {
    clearTimeout(timer.current);
    if (v !== props.value) props.onCommit(v);
  };
  return (
    <input
      className={props.className}
      value={draft}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        commit(draft);
      }}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(v), 400);
      }}
    />
  );
}

const OPTIONS = {
  status: ["Todo", "In progress", "Done"],
  priority: ["Low", "Medium", "High"],
  assignee: Object.keys(DEMO_USERS),
} as const;
type Column = keyof typeof OPTIONS;

function DatabaseView({ databaseId, workspaceId, canEdit, onSelect }: { databaseId: string; workspaceId: string; canEdit: boolean; onSelect: (id: string) => void }) {
  const db = usePowerSync();
  const { data } = useQuery<Node>("SELECT * FROM nodes WHERE parent_id = ? AND kind = 'db_row' AND deleted_at IS NULL", [databaseId]);
  const rows = [...data].sort((a, b) => compareRank({ rank: a.rank!, id: a.id }, { rank: b.rank!, id: b.id }));

  const addRow = () =>
    createNode(db, {
      workspaceId,
      parentId: databaseId,
      kind: "db_row",
      rank: rankAfter(rows.at(-1)?.rank),
      title: "",
      props: { status: "Todo", priority: "Medium" },
    });

  return (
    <div className="db">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            {(Object.keys(OPTIONS) as Column[]).map((c) => (
              <th key={c}>{c[0]!.toUpperCase() + c.slice(1)}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const props = JSON.parse(row.props || "{}") as Record<string, string>;
            return (
              <tr key={row.id}>
                <td>
                  <TextField value={row.title ?? ""} placeholder="Untitled" disabled={!canEdit} onCommit={(title) => updateNode(db, row.id, { title })} />
                </td>
                {(Object.keys(OPTIONS) as Column[]).map((c) => (
                  <td key={c}>
                    <select
                      className={`cell ${c}-${(props[c] ?? "").replace(/\s/g, "")}`}
                      value={props[c] ?? ""}
                      disabled={!canEdit}
                      onChange={(e) => setProp(db, row.id, c, e.target.value)}
                    >
                      <option value="">—</option>
                      {OPTIONS[c].map((o) => (
                        <option key={o} value={o}>
                          {c === "assignee" ? DEMO_USERS[o as DemoUserId].name : o}
                        </option>
                      ))}
                    </select>
                  </td>
                ))}
                <td className="row-actions">
                  <button title="Open as page" onClick={() => onSelect(row.id)}>↗</button>
                  {canEdit && (
                    <button title="Delete row" onClick={() => deleteNode(db, row.id)}>
                      🗑
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {canEdit && (
        <button className="link" onClick={addRow}>
          ＋ New row
        </button>
      )}
    </div>
  );
}
