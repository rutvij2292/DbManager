import { test } from "node:test";
import assert from "node:assert/strict";
import { tabsOf, nextAfterClose, nthTab, cycleTab, tabForSwitch } from "../.test-build/workspace.mjs";

const A = { name: "A" }, B = { name: "B" };
const tab = (id, server) => ({ id, conn: server ? { server } : null });
// Interleaved on purpose: the global list mixes both connections.
const a1 = tab("a1", A), b1 = tab("b1", B), a2 = tab("a2", A), b2 = tab("b2", B), a3 = tab("a3", A);
const all = [a1, b1, a2, b2, a3];

test("a connection only ever sees its own tabs", () => {
  assert.deepEqual(tabsOf(all, A).map((t) => t.id), ["a1", "a2", "a3"]);
  assert.deepEqual(tabsOf(all, B).map((t) => t.id), ["b1", "b2"]);
  assert.deepEqual(tabsOf(all, null), []);
  assert.deepEqual(tabsOf([tab("x", null)], A), [], "a tab without a connection belongs to nobody");
});

test("closing a tab never hands focus to another connection's tab", () => {
  assert.equal(nextAfterClose(all, a2).id, "a3", "the neighbour in the same connection");
  assert.equal(nextAfterClose(all, a3).id, "a2", "last tab falls back to the previous one of the same connection");
  assert.equal(nextAfterClose(all, a1).id, "a2");
  // The only tab of B: nothing to take over, even though A has plenty.
  assert.equal(nextAfterClose([a1, a2, b1], b1), null);
  for (const t of all) {
    const n = nextAfterClose(all, t);
    if (n) assert.equal(n.conn.server, t.conn.server, `closing ${t.id} must stay inside its connection`);
  }
});

test("⌘1…⌘9 index into the current connection's tabs, not the global list", () => {
  assert.equal(nthTab(all, B, 1).id, "b1");
  assert.equal(nthTab(all, B, 2).id, "b2");
  assert.equal(nthTab(all, B, 3), null, "B has two tabs; the third global slot belongs to A and must not be returned");
  assert.equal(nthTab(all, A, 3).id, "a3");
});

test("next / previous tab wraps inside one connection", () => {
  assert.equal(cycleTab(all, a1, 1).id, "a2");
  assert.equal(cycleTab(all, a3, 1).id, "a1", "wraps to A's first, never to B's");
  assert.equal(cycleTab(all, a1, -1).id, "a3");
  assert.equal(cycleTab(all, b2, 1).id, "b1");
  assert.equal(cycleTab(all, null, 1), null);
  for (const t of all) for (const d of [1, -1, 2, -2]) assert.equal(cycleTab(all, t, d).conn.server, t.conn.server);
});

test("switching connection restores its last tab, or its newest, and never a foreign one", () => {
  assert.equal(tabForSwitch(all, A, a2).id, "a2");
  assert.equal(tabForSwitch(all, A, null).id, "a3");
  assert.equal(tabForSwitch(all, A, b1).id, "a3", "a remembered tab from another connection is ignored");
  assert.equal(tabForSwitch(all, A, tab("closed", A)).id, "a3", "a remembered tab that no longer exists is ignored");
  assert.equal(tabForSwitch([a1], B, null), null);
});
