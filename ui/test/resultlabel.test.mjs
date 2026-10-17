import test from "node:test";
import assert from "node:assert/strict";
import { statementLabel, resultCaption } from "../.test-build/resultlabel.mjs";

test("labels name the verb and the table", () => {
  assert.equal(statementLabel("SELECT * FROM users WHERE id = 1"), "SELECT users");
  assert.equal(statementLabel("select a from public.orders o join x"), "SELECT public.orders");
  assert.equal(statementLabel('SELECT 1 FROM "My Table"'), "SELECT My Table");
  assert.equal(statementLabel("UPDATE items SET a = 1"), "UPDATE items");
  assert.equal(statementLabel("INSERT INTO `t` (a) VALUES (1)"), "INSERT t");
  assert.equal(statementLabel("DELETE FROM logs"), "DELETE logs");
  assert.equal(statementLabel("CREATE TABLE IF NOT EXISTS a (id int)"), "CREATE TABLE a");
  assert.equal(statementLabel("DROP INDEX idx_a"), "DROP INDEX idx_a");
  assert.equal(statementLabel("WITH x AS (SELECT 1) SELECT * FROM x"), "WITH x");
});

test("labels survive comments, no FROM, unknown verbs, and long names", () => {
  assert.equal(statementLabel("-- hi\n/* c */ SELECT 1"), "SELECT");
  assert.equal(statementLabel("PRAGMA foreign_keys = ON"), "PRAGMA foreign_keys");
  assert.equal(statementLabel(""), "Statement");
  assert.ok(statementLabel("SELECT * FROM " + "a".repeat(80)).length <= 28);
});

test("captions", () => {
  assert.deepEqual(resultCaption({ sql: "SELECT * FROM t", hasRows: true, count: 1200, ms: 4 }), { label: "SELECT t", detail: "1,200 rows · 4 ms" });
  assert.equal(resultCaption({ sql: "UPDATE t SET a=1", hasRows: false, count: 1, ms: 2 }).detail, "1 affected · 2 ms");
  assert.equal(resultCaption({ sql: "x", error: "boom", hasRows: false, count: 0 }).detail, "error");
});
