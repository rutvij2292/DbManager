import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
const q = await import("../.test-build/qstore.mjs");

test("history is in memory: newest first, repeats move up, capped", () => {
  let h = [];
  h = q.pushHistory(h, { sql: "select 1", at: 1, ms: 5, ok: true });
  h = q.pushHistory(h, { sql: "select 2", at: 2, ms: 5, ok: false });
  h = q.pushHistory(h, { sql: " select 1 ", at: 3, ms: 9, ok: true });
  h = q.pushHistory(h, { sql: "   ", at: 4, ms: 0, ok: true });
  assert.deepEqual(h.map((x) => [x.sql, x.at]), [["select 1", 3], ["select 2", 2]]);
  for (let i = 0; i < 150; i++) h = q.pushHistory(h, { sql: `q${i}`, at: 10 + i, ms: 1, ok: true });
  assert.equal(h.length, 100);
  assert.equal(h[0].sql, "q149");
  assert.equal(mem.size, 0, "nothing was written to storage");
});

test("favourites: one click adds, repeats are recognised, names stay unique", () => {
  const a = q.addFavorite("p1", "select * from orders where id = 1", 1);
  assert.ok(a.added);
  assert.equal(a.fav.name, "select * from orders where id = 1");
  assert.equal(q.addFavorite("p1", "  select * from orders where id = 1 ", 2).added, false);
  const long = "select " + "x, ".repeat(30) + "y from t";
  const b = q.addFavorite("p1", long, 3), c = q.addFavorite("p1", long + " where 1=1", 4);
  assert.notEqual(b.fav.name, c.fav.name, "same 40-character prefix gets a numbered name");
  assert.equal(q.loadSaved("p2").length, 0);
  assert.ok(q.findFavorite("p1", "select * from orders where id = 1"));
  q.renameQuery("p1", a.fav.id, "Order one");
  assert.ok(q.loadSaved("p1").some((s) => s.name === "Order one"));
  q.deleteQuery("p1", a.fav.id);
  assert.equal(q.findFavorite("p1", "select * from orders where id = 1"), undefined);
});

test("saving under an existing name replaces it", () => {
  q.saveQuery("p3", "Daily", "select 1", 1);
  q.saveQuery("p3", "daily", "select 2", 2);
  assert.deepEqual(q.loadSaved("p3").map((s) => s.sql), ["select 2"]);
});

test("drafts: kept per key in order, updated in place, blank removes, capped", () => {
  q.saveDraft("k", "a", "Query", "select 1", 1);
  q.saveDraft("k", "b", "Query", "select 2", 2);
  q.saveDraft("k", "a", "Query", "select 1 -- edited", 3);
  assert.deepEqual(q.loadDrafts("k").map((d) => [d.id, d.sql]), [["a", "select 1 -- edited"], ["b", "select 2"]], "an edit keeps its tab position");
  q.removeDraft("k", "a");
  q.saveDraft("k", "b", "Query", "   ", 4);
  assert.deepEqual(q.loadDrafts("k"), []);
  for (let i = 0; i < 20; i++) q.saveDraft("many", `d${i}`, "Query", `select ${i}`, i);
  assert.equal(q.loadDrafts("many").length, 12);
  assert.equal(q.loadDrafts("other").length, 0);
});

test("legacy persistent history is dropped", () => {
  mem.set("tabnix.history", "{}");
  q.dropLegacyHistory();
  assert.equal(mem.has("tabnix.history"), false);
});
