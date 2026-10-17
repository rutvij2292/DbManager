import { test } from "node:test";
import assert from "node:assert/strict";
import { touchRecent, sortByRecent } from "../.test-build/recent.mjs";

const P = (id, name) => ({ id, name });
const list = [P("c", "Charlie"), P("a", "alpha"), P("b", "Bravo")];

test("never-used profiles sort by name", () => {
  assert.deepEqual(sortByRecent(list, {}).map((p) => p.id), ["a", "b", "c"]);
});
test("used ones come first, newest first", () => {
  assert.deepEqual(sortByRecent(list, { c: 5, b: 9 }).map((p) => p.id), ["b", "c", "a"]);
});
test("touchRecent does not mutate its input", () => {
  const u = { a: 1 };
  const n = touchRecent(u, "b", 2);
  assert.deepEqual(u, { a: 1 });
  assert.deepEqual(n, { a: 1, b: 2 });
});
test("touchRecent prunes to keep", () => {
  const n = touchRecent({ a: 1, b: 2, c: 3 }, "d", 4, 2);
  assert.deepEqual(Object.keys(n).sort(), ["c", "d"]);
});
test("ties fall back to name", () => {
  assert.deepEqual(sortByRecent(list, { c: 5, b: 5 }).map((p) => p.id), ["b", "c", "a"]);
});
