import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
const q = await import("../.test-build/qstore.mjs");

test("history: newest first, repeats move to the top, capped", () => {
  const k = "c|db";
  q.addHistory(k, { sql: "select 1", at: 1, ms: 5, ok: true });
  q.addHistory(k, { sql: "select 2", at: 2, ms: 5, ok: false });
  q.addHistory(k, { sql: " select 1 ", at: 3, ms: 9, ok: true });
  q.addHistory(k, { sql: "   ", at: 4, ms: 0, ok: true });
  assert.deepEqual(q.loadHistory(k).map((h) => [h.sql, h.at]), [["select 1", 3], ["select 2", 2]]);
  for (let i = 0; i < 150; i++) q.addHistory(k, { sql: `q${i}`, at: 10 + i, ms: 1, ok: true });
  assert.equal(q.loadHistory(k).length, 100);
  q.removeHistory(k, 159);
  assert.ok(!q.loadHistory(k).some((h) => h.sql === "q149"));
  q.clearHistory(k);
  assert.deepEqual(q.loadHistory(k), []);
});

test("saved queries: per connection, replace by name, rename, delete", () => {
  const a = q.saveQuery("p1", "Daily sales", "select 1", 1);
  q.saveQuery("p1", "Active users", "select 2", 2);
  q.saveQuery("p2", "Other", "select 3", 3);
  assert.deepEqual(q.loadSaved("p1").map((s) => s.name), ["Active users", "Daily sales"]);
  q.saveQuery("p1", "daily SALES", "select 9", 4);
  assert.equal(q.loadSaved("p1").length, 2, "same name replaces");
  const b = q.loadSaved("p1").find((s) => s.sql === "select 2");
  q.renameQuery("p1", b.id, "Zeta");
  assert.deepEqual(q.loadSaved("p1").map((s) => s.name), ["daily SALES", "Zeta"]);
  q.deleteQuery("p1", b.id);
  assert.deepEqual(q.loadSaved("p1").map((s) => s.name), ["daily SALES"]);
  assert.equal(q.loadSaved("p2").length, 1);
  assert.ok(a.id);
});
