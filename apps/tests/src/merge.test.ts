import { describe, expect, test } from "bun:test";
import { packHlc } from "@sync/shared";
import { mergeNode, type NodeState } from "@sync/api/merge";

const h = (ts: number, node = "c") => packHlc({ ts, counter: 0, node });
const server = (over: Partial<NodeState> = {}): NodeState => ({
  parent_id: null,
  kind: "page",
  rank: "a0",
  title: "Server title",
  icon: null,
  props: { status: "Todo", priority: "Low" },
  deleted_at: null,
  hlc_updated_at: h(100, "srv"),
  ...over,
});

describe("mergeNode (HLC LWW + three-way merge)", () => {
  test("newer HLC wins a true conflict on the same field", () => {
    const { changes, hlc } = mergeNode(server(), { title: "Mine", hlc_updated_at: h(200) }, { title: "Base" });
    expect(changes).toEqual({ title: "Mine" });
    expect(hlc).toBe(h(200));
  });

  test("older HLC loses a true conflict on the same field", () => {
    const { changes, hlc } = mergeNode(server(), { title: "Stale", hlc_updated_at: h(50) }, { title: "Base" });
    expect(changes).toEqual({});
    expect(hlc).toBe(h(100, "srv"));
  });

  test("older offline edit to a different field still applies", () => {
    // Server title changed by someone else; this client changed only the icon from its base.
    const { changes } = mergeNode(server({ icon: null }), { icon: "🚀", hlc_updated_at: h(50) }, { icon: null });
    expect(changes).toEqual({ icon: "🚀" });
  });

  test("props merge per key: concurrent edits to different keys both survive", () => {
    // Alice already set status=Done on the server. Bob, offline from an older base, set priority=High.
    const current = server({ props: { status: "Done", priority: "Low" } });
    const bob = { props: { status: "Todo", priority: "High" }, hlc_updated_at: h(50) };
    const { changes } = mergeNode(current, bob, { props: JSON.stringify({ status: "Todo", priority: "Low" }) });
    expect(changes.props).toEqual({ status: "Done", priority: "High" });
  });

  test("props: newer HLC wins a same-key conflict, older loses", () => {
    const current = server({ props: { status: "Done" } });
    const base = { props: '{"status":"Todo"}' };
    expect(mergeNode(current, { props: { status: "In progress" }, hlc_updated_at: h(200) }, base).changes.props).toEqual({
      status: "In progress",
    });
    expect(mergeNode(current, { props: { status: "In progress" }, hlc_updated_at: h(50) }, base).changes).toEqual({});
  });

  test("props: adding a brand-new key applies even with an old clock", () => {
    const { changes } = mergeNode(server(), { props: { status: "Todo", priority: "Low", assignee: "bob" }, hlc_updated_at: h(1) }, {
      props: { status: "Todo", priority: "Low" },
    });
    expect(changes.props).toEqual({ status: "Todo", priority: "Low", assignee: "bob" });
  });

  test("without a merge base only the HLC decides", () => {
    expect(mergeNode(server(), { icon: "x", hlc_updated_at: h(50) }, undefined).changes).toEqual({});
    expect(mergeNode(server(), { icon: "x", hlc_updated_at: h(150) }, undefined).changes).toEqual({ icon: "x" });
  });

  test("no-op patches produce no changes", () => {
    expect(mergeNode(server(), { title: "Server title", hlc_updated_at: h(500) }, { title: "Server title" }).changes).toEqual({});
  });

  test("deleted_at compares across SQLite/Postgres timestamp formats", () => {
    const current = server({ deleted_at: "2026-01-01 10:00:00+00" });
    const { changes } = mergeNode(current, { deleted_at: null, hlc_updated_at: h(50) }, { deleted_at: "2026-01-01T10:00:00.000Z" });
    expect(changes).toEqual({ deleted_at: null });
  });
});
