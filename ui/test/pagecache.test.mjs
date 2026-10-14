import { test } from "node:test";
import assert from "node:assert/strict";
import { PageCache } from "../.test-build/pagecache.mjs";

test("never holds more than max pages and drops the least recently used", () => {
  const c = new PageCache(3);
  for (let p = 0; p < 10; p++) c.set(p, "p" + p);
  assert.equal(c.size, 3);
  assert.deepEqual([7, 8, 9].map((p) => c.has(p)), [true, true, true]);
  assert.equal(c.has(0), false);
});

test("touching a page protects it from eviction", () => {
  const c = new PageCache(3);
  c.set(0, "a"); c.set(1, "b"); c.set(2, "c");
  c.touch(0);
  c.set(3, "d");
  assert.equal(c.has(0), true);
  assert.equal(c.has(1), false);
});

test("pinned pages (staged edits) survive even past the limit", () => {
  const c = new PageCache(2);
  const pinned = new Set([0]);
  for (let p = 0; p < 6; p++) c.set(p, "p" + p, pinned);
  assert.equal(c.has(0), true);
  assert.equal(c.has(5), true);
  assert.equal(c.size, 2);
});

test("the page just stored is never the one evicted, and touch reports misses", () => {
  const c = new PageCache(1);
  c.set(4, "x"); c.set(9, "y");
  assert.equal(c.has(9), true);
  assert.equal(c.touch(4), false);
  assert.equal(c.peek(9), "y");
});
