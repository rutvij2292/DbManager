import { test } from "node:test";
import assert from "node:assert/strict";
import { layout } from "../.test-build/diagram-layout.mjs";

const n = (id, h = 100, w = 180) => ({ id, w, h });
const overlaps = (a, b, pos, size) => {
  const p = pos.get(a), q = pos.get(b), A = size.get(a), B = size.get(b);
  return p.x < q.x + B.w && q.x < p.x + A.w && p.y < q.y + B.h && q.y < p.y + A.h;
};

test("parents sit left of the tables that reference them", () => {
  const nodes = [n("item"), n("orders"), n("customer"), n("country")];
  const edges = [{ from: "item", to: "orders" }, { from: "orders", to: "customer" }, { from: "customer", to: "country" }];
  const { pos } = layout(nodes, edges);
  assert.ok(pos.get("country").x < pos.get("customer").x);
  assert.ok(pos.get("customer").x < pos.get("orders").x);
  assert.ok(pos.get("orders").x < pos.get("item").x);
});

test("no two boxes overlap, including isolated tables", () => {
  const nodes = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id, i) => n(id, 60 + i * 15));
  const edges = [{ from: "b", to: "a" }, { from: "c", to: "a" }, { from: "d", to: "b" }, { from: "d", to: "c" }];
  const { pos, width, height } = layout(nodes, edges);
  const size = new Map(nodes.map((x) => [x.id, x]));
  for (const a of nodes) for (const b of nodes) if (a.id < b.id) assert.ok(!overlaps(a.id, b.id, pos, size), `${a.id} overlaps ${b.id}`);
  assert.equal(pos.size, nodes.length);
  assert.ok(width > 0 && height > 0);
});

test("reference cycles and self-references terminate and still place every table", () => {
  const nodes = [n("a"), n("b"), n("c"), n("tree")];
  const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }, { from: "tree", to: "tree" }];
  const { pos } = layout(nodes, edges);
  assert.equal(pos.size, 4);
});

test("empty input", () => {
  const { pos, width, height } = layout([], []);
  assert.deepEqual([pos.size, width, height], [0, 0, 0]);
});
