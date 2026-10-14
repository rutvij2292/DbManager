import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSql, emptyModel, suggestJoin } from "../.test-build/builder-sql.mjs";

const dq = (s) => `"${s}"`;
const r = (table, col, schema = null) => ({ table, schema, col });

test("simple select with filter, order, limit", () => {
  const m = emptyModel();
  m.from = { table: "users", schema: null };
  m.cols = [{ ref: r("users", "id"), agg: "" }, { ref: r("users", "name"), agg: "" }];
  m.filters = [{ ref: r("users", "age"), op: ">=", value: "18" }, { ref: r("users", "name"), op: "LIKE", value: "o'b%" }];
  m.orderBy = [{ ref: r("users", "id"), dir: "DESC" }];
  assert.equal(buildSql(m, dq), `SELECT "users"."id", "users"."name"\nFROM "users"\nWHERE "users"."age" >= 18\n  AND "users"."name" LIKE 'o''b%'\nORDER BY "users"."id" DESC\nLIMIT 100;`);
});

test("join, aggregate adds GROUP BY, schema qualification, backticks", () => {
  const m = emptyModel();
  m.from = { table: "orders", schema: "sales" };
  m.joins = [{ type: "LEFT", table: "users", schema: "public", left: r("orders", "user_id", "sales"), right: r("users", "id") }];
  m.cols = [{ ref: r("users", "name"), agg: "" }, { ref: r("orders", "total"), agg: "SUM" }];
  m.limit = null;
  assert.equal(buildSql(m, (s) => `\`${s}\``), "SELECT `users`.`name`, SUM(`orders`.`total`) AS `sum_total`\nFROM `sales`.`orders`\nLEFT JOIN `users` ON `orders`.`user_id` = `users`.`id`\nGROUP BY `users`.`name`;");
});

test("IN / IS NULL / OR / empty values skipped; COUNT(*)", () => {
  const m = emptyModel();
  m.from = { table: "t", schema: null };
  m.countAll = true;
  m.filters = [
    { ref: r("t", "a"), op: "IN", value: "1, two ,3" },
    { ref: r("t", "b"), op: "IS NULL", value: "", or: true },
    { ref: r("t", "c"), op: "=", value: "" },
  ];
  m.limit = null;
  assert.equal(buildSql(m, dq), `SELECT COUNT(*) AS "count"\nFROM "t"\nWHERE "t"."a" IN (1, 'two', 3)\n  OR "t"."b" IS NULL;`);
});

test("no table -> empty; join suggestions", () => {
  assert.equal(buildSql(emptyModel(), dq), "");
  const users = { schema: null, name: "users", columns: ["id", "name"] };
  const orders = { schema: null, name: "orders", columns: ["id", "user_id", "total"] };
  const j = suggestJoin([users], orders);
  assert.deepEqual([j.left.col, j.right.col], ["id", "user_id"]);
  const j2 = suggestJoin([orders], users);
  assert.deepEqual([j2.left.col, j2.right.col], ["user_id", "id"]);
  assert.equal(suggestJoin([users], { schema: null, name: "x", columns: ["a"] }), null);
});

test("T-SQL uses TOP instead of LIMIT", () => {
  const m = emptyModel();
  m.from = { table: "t", schema: "dbo" };
  m.limit = 10;
  assert.equal(buildSql(m, (s) => `[${s}]`, true), "SELECT TOP 10 *\nFROM [dbo].[t];".replace("[dbo].", "[dbo].") );
});

import { buildWhere } from "../.test-build/builder-sql.mjs";

test("row filter: operators, escaping, AND/OR, blanks skipped", () => {
  const q = (s) => `"${s}"`;
  assert.equal(buildWhere([], q), "");
  assert.equal(buildWhere([
    { col: "status", op: "=", value: "paid" },
    { col: "total", op: ">=", value: "100" },
    { col: "name", op: "contains", value: "50%_o'b" },
    { col: "x", op: "=", value: "" },                       // blank value: ignored
    { col: "note", op: "is null", value: "", or: true },
    { col: "id", op: "in list", value: "1, 2 ,three" },
  ], q), `"status" = 'paid' AND "total" >= 100 AND "name" LIKE '%50!%!_o''b%' ESCAPE '!' OR "note" IS NULL AND "id" IN (1, 2, 'three')`);
  // The first rule's AND/OR is irrelevant; a leading OR must not leak into the SQL.
  assert.equal(buildWhere([{ col: "a", op: "begins with", value: "x", or: true }], q), `"a" LIKE 'x%' ESCAPE '!'`);
});

import { buildOrder, nextSort, wrapForSort } from "../.test-build/builder-sql.mjs";

test("sorting: ORDER BY body, quoting", () => {
  const q = (s) => `"${s}"`;
  assert.equal(buildOrder([], q), "");
  assert.equal(buildOrder([{ col: "total", desc: true }, { col: "na\"me", desc: false }], (s) => `"${s.replace(/"/g, '""')}"`), `"total" DESC, "na""me" ASC`);
});

test("sorting: a plain click cycles asc → desc → off on one column", () => {
  let s = [];
  s = nextSort(s, "a", false); assert.deepEqual(s, [{ col: "a", desc: false }]);
  s = nextSort(s, "a", false); assert.deepEqual(s, [{ col: "a", desc: true }]);
  s = nextSort(s, "a", false); assert.deepEqual(s, []);
  // Clicking another column replaces the sort instead of stacking.
  s = nextSort([{ col: "a", desc: true }], "b", false); assert.deepEqual(s, [{ col: "b", desc: false }]);
  // A multi-column sort collapses to the clicked column.
  s = nextSort([{ col: "a", desc: false }, { col: "b", desc: false }], "a", false); assert.deepEqual(s, [{ col: "a", desc: false }]);
});

test("sorting: shift-click adds keys, flips them, then drops them", () => {
  let s = nextSort([{ col: "a", desc: false }], "b", true);
  assert.deepEqual(s, [{ col: "a", desc: false }, { col: "b", desc: false }]);
  s = nextSort(s, "b", true); assert.deepEqual(s, [{ col: "a", desc: false }, { col: "b", desc: true }]);
  s = nextSort(s, "b", true); assert.deepEqual(s, [{ col: "a", desc: false }]);
});

test("sorting a query result wraps it, and refuses what it can't wrap safely", () => {
  const q = (s) => `\`${s}\``;
  const sort = [{ col: "total", desc: true }];
  assert.equal(wrapForSort("SELECT id, total FROM orders WHERE x = 1;  ", sort, q), "SELECT * FROM (SELECT id, total FROM orders WHERE x = 1) AS lattice_sorted ORDER BY `total` DESC");
  assert.ok(wrapForSort("WITH t AS (SELECT 1 AS a) SELECT * FROM t", sort, q));
  assert.equal(wrapForSort("UPDATE t SET a = 1", sort, q), null, "not a SELECT");
  assert.equal(wrapForSort("SELECT 1; SELECT 2", sort, q), null, "two statements");
  assert.equal(wrapForSort("SELECT 1", [], q), null, "nothing to sort by");
  assert.equal(wrapForSort("  ;; ", sort, q), null);
});
