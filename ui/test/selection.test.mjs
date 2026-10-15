import { test } from "node:test";
import assert from "node:assert/strict";
import { clickSelect } from "../.test-build/selection.mjs";

const order = ["a", "b", "c", "d", "e"], none = { picked: new Set(), anchor: null };

test("single click replaces the selection", () => {
  const s = clickSelect({ picked: new Set(["a", "b"]), anchor: "a" }, order, "c", "single");
  assert.deepEqual([...s.picked], ["c"]); assert.equal(s.anchor, "c");
});
test("toggle adds and removes", () => {
  let s = clickSelect(none, order, "a", "toggle"); s = clickSelect(s, order, "c", "toggle");
  assert.deepEqual([...s.picked].sort(), ["a", "c"]);
  s = clickSelect(s, order, "a", "toggle");
  assert.deepEqual([...s.picked], ["c"]);
});
test("range selects between anchor and target, either direction, keeping the anchor", () => {
  let s = clickSelect(none, order, "b", "single");
  s = clickSelect(s, order, "d", "range");
  assert.deepEqual([...s.picked], ["b", "c", "d"]);
  s = clickSelect(s, order, "a", "range");
  assert.deepEqual([...s.picked], ["a", "b"]);
});
test("range with no usable anchor falls back to single", () => {
  assert.deepEqual([...clickSelect(none, order, "c", "range").picked], ["c"]);
  assert.deepEqual([...clickSelect({ picked: new Set(["x"]), anchor: "x" }, order, "c", "range").picked], ["c"]);
});
