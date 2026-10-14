import { test } from "node:test";
import assert from "node:assert/strict";
import { splitStatements, statementAt } from "../.test-build/sqlsplit.mjs";

test("splits on semicolons outside strings, comments and $$ bodies", () => {
  const sql = "select 'a;b' as x; -- no; split\nselect \"c;d\"; /* x; */ select `e;f`;\ncreate function f() returns int as $$ begin; return 1; end $$ language plpgsql; select 1";
  assert.deepEqual(splitStatements(sql).map((s) => s.text.slice(0, 18)), ["select 'a;b' as x", "-- no; split\nselec".slice(0, 18), "/* x; */ select `e", "create function f(", "select 1"]);
});

test("comment-only chunks are dropped and offsets point into the text", () => {
  const sql = "select 1;\n-- just a comment\n;select 2";
  const s = splitStatements(sql);
  assert.equal(s.length, 2);
  assert.equal(sql.slice(s[1].from, s[1].to), "select 2");
});

test("statementAt picks the statement under the cursor", () => {
  const sql = "select 1;\nselect 2;\nselect 3";
  assert.equal(statementAt(sql, 3)?.text, "select 1");
  assert.equal(statementAt(sql, 12)?.text, "select 2");
  assert.equal(statementAt(sql, 9)?.text, "select 1", "right behind the semicolon still means that statement");
  assert.equal(statementAt(sql, sql.length)?.text, "select 3");
  assert.equal(statementAt("   ", 1), null);
});
