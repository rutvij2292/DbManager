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
