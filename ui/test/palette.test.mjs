import { test } from "node:test";
import assert from "node:assert/strict";
import { paletteResults } from "../.test-build/palette-rank.mjs";

const A = (id, label) => ({ id, label, group: "g", combo: "meta+x" });
const actions = [A("palette", "Quick open"), A("commit", "Commit changes"), A("discard", "Discard uncommitted changes"), A("commitAll", "Commit all tables…"), A("theme", "Switch light / dark theme")];
const O = (name) => ({ name, kind: "table" });
const names = (r) => r.objects.map((o) => o.name);
const ids = (r) => r.actions.map((a) => a.id);

test("empty query lists objects, no actions", () => {
  const r = paletteResults("", [O("a"), O("b")], actions);
  assert.deepEqual(names(r), ["a", "b"]);
  assert.deepEqual(r.actions, []);
});

test("exact, then prefix, then substring", () => {
  const r = paletteResults("ord", [O("customer_orders"), O("orders"), O("ord")], actions);
  assert.deepEqual(names(r), ["ord", "orders", "customer_orders"]);
});

test("'>' lists every action except palette, in order, no objects", () => {
  const r = paletteResults(">", [O("orders")], actions);
  assert.deepEqual(r.objects, []);
  assert.deepEqual(ids(r), ["commit", "discard", "commitAll", "theme"]);
});

test("'>commit' matches by word start", () => {
  const r = paletteResults(">commit", [], actions);
  assert.deepEqual(ids(r), ["commit", "commitAll"]);
});

test("'theme' with no object match", () => {
  const r = paletteResults("theme", [O("orders")], actions);
  assert.deepEqual(r.objects, []);
  assert.ok(ids(r).includes("theme"));
});

test("case-insensitive", () => {
  const objs = [O("customer_orders"), O("orders"), O("ord")];
  assert.deepEqual(paletteResults("ORD", objs, actions), paletteResults("ord", objs, actions));
});

test("respects max.objects", () => {
  const objs = Array.from({ length: 10 }, (_, i) => O("t" + i));
  assert.equal(paletteResults("t", objs, actions, { objects: 3, actions: 6 }).objects.length, 3);
  assert.equal(paletteResults("", objs, actions, { objects: 4, actions: 6 }).objects.length, 4);
});

test("'> ' behaves like '>'", () => {
  assert.deepEqual(paletteResults("> ", [], actions), paletteResults(">", [], actions));
});
