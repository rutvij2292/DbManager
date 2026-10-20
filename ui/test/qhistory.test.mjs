import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
const { sessionKey, ago } = await import("../.test-build/qhistory.mjs");

test("keys are per connection and database", () => {
  assert.equal(sessionKey("c1", "pos"), "c1|pos");
  assert.equal(sessionKey("c1", null), "c1|");
  assert.notEqual(sessionKey("c1", "a"), sessionKey("c1", "b"));
});

test("ago", () => {
  assert.equal(ago(0, 30_000), "just now");
  assert.equal(ago(0, 5 * 60_000), "5 min ago");
  assert.equal(ago(0, 3 * 3600_000), "3 h ago");
  assert.equal(ago(0, 30 * 3600_000), "yesterday");
});
