import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
const { sessionKey, loadSessions, addSession, removeSessions, ago } = await import("../.test-build/qhistory.mjs");

test("sessions are kept per connection and database, newest first, without repeats", () => {
  const a = sessionKey("c1", "pos"), b = sessionKey("c1", "hrms");
  addSession(a, "select 1", 1000);
  addSession(a, "select 2", 2000);
  addSession(a, "select 1", 3000);
  addSession(b, "select 9", 1500);
  addSession(a, "   ", 4000);
  assert.deepEqual(loadSessions(a).map((s) => s.sql), ["select 1", "select 2"]);
  assert.deepEqual(loadSessions(b).map((s) => s.sql), ["select 9"]);
  assert.deepEqual(loadSessions(sessionKey("c2", "pos")), []);
});

test("shown sessions are dropped, the rest stay", () => {
  const k = sessionKey("c3", "x");
  for (let i = 1; i <= 3; i++) addSession(k, `q${i}`, i);
  removeSessions(k, loadSessions(k).slice(0, 2));
  assert.deepEqual(loadSessions(k).map((s) => s.sql), ["q1"]);
  removeSessions(k, loadSessions(k));
  assert.deepEqual(loadSessions(k), []);
});

test("history is capped", () => {
  const k = sessionKey("c4", null);
  for (let i = 0; i < 20; i++) addSession(k, `q${i}`, i);
  assert.equal(loadSessions(k).length, 8);
  assert.equal(loadSessions(k)[0].sql, "q19");
});

test("ago", () => {
  assert.equal(ago(0, 30_000), "just now");
  assert.equal(ago(0, 5 * 60_000), "5 min ago");
  assert.equal(ago(0, 3 * 3600_000), "3 h ago");
  assert.equal(ago(0, 30 * 3600_000), "yesterday");
});
