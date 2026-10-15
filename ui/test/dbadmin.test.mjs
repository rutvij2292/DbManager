import { test } from "node:test";
import assert from "node:assert/strict";
import { createDatabaseSql, dropDatabaseSql, truncateAllSql, truncateTableSql, dropTableSql, truncateTablesSql, dropTablesSql, isForeignKeyError, destructiveKind, isReadOnlySql, safetyLevel } from "../.test-build/dbadmin.mjs";

test("create / drop database per engine", () => {
  assert.equal(createDatabaseSql("mysql", "my`db"), "CREATE DATABASE `my``db`");
  assert.equal(createDatabaseSql("postgres", "shop"), 'CREATE DATABASE "shop"');
  assert.equal(createDatabaseSql("sqlite", "x"), null);
  assert.deepEqual(dropDatabaseSql("postgres", "shop"), ['DROP DATABASE "shop" WITH (FORCE)']);
  assert.deepEqual(dropDatabaseSql("postgres", "shop", false), ['DROP DATABASE "shop"']);
  assert.deepEqual(dropDatabaseSql("mysql", "shop"), ["DROP DATABASE `shop`"]);
  assert.equal(dropDatabaseSql("mssql", "shop").length, 2);
});

test("truncate all tables", () => {
  const t = [{ schema: "public", name: "a" }, { schema: "billing", name: "b" }];
  assert.deepEqual(truncateAllSql("mysql", [{ schema: null, name: "a" }, { schema: null, name: "b" }]), ["SET FOREIGN_KEY_CHECKS=0", "TRUNCATE TABLE `a`", "TRUNCATE TABLE `b`", "SET FOREIGN_KEY_CHECKS=1"]);
  assert.deepEqual(truncateAllSql("postgres", t), ['TRUNCATE TABLE "a", "billing"."b" RESTART IDENTITY CASCADE']);
  assert.deepEqual(truncateAllSql("sqlite", [{ schema: null, name: "a" }]), ['DELETE FROM "a"']);
  assert.equal(truncateAllSql("mssql", t), null);
  assert.deepEqual(truncateAllSql("mysql", []), []);
});

test("single table, with and without ignoring foreign keys", () => {
  const t = { schema: null, name: "a" };
  assert.deepEqual(truncateTableSql("mysql", t), ["TRUNCATE TABLE `a`"]);
  assert.deepEqual(truncateTableSql("mysql", t, true), ["SET FOREIGN_KEY_CHECKS=0", "TRUNCATE TABLE `a`", "SET FOREIGN_KEY_CHECKS=1"]);
  assert.deepEqual(truncateTableSql("sqlite", t), ['DELETE FROM "a"']);
  assert.deepEqual(truncateTableSql("postgres", t, true), ['TRUNCATE TABLE "a" CASCADE']);
  assert.deepEqual(dropTableSql("postgres", { schema: "s", name: "v", kind: "view" }), ['DROP VIEW "s"."v"']);
  assert.deepEqual(dropTableSql("mysql", t, true), ["SET FOREIGN_KEY_CHECKS=0", "DROP TABLE `a`", "SET FOREIGN_KEY_CHECKS=1"]);
});

test("foreign key errors are recognised", () => {
  assert.ok(isForeignKeyError("Cannot truncate a table referenced in a foreign key constraint (`db`.`x`, CONSTRAINT `fk`)"));
  assert.ok(isForeignKeyError("ERROR 1451 (23000): Cannot delete or update a parent row"));
  assert.ok(isForeignKeyError('cannot truncate a table referenced in a foreign key constraint'));
  assert.ok(!isForeignKeyError("syntax error near 'x'"));
});

test("destructive statements are spotted, safe ones are not", () => {
  assert.equal(destructiveKind("DROP TABLE users")?.kind, "drop");
  assert.equal(destructiveKind("select 1; truncate table a;")?.kind, "truncate");
  assert.equal(destructiveKind("DELETE FROM orders")?.kind, "delete-all");
  assert.equal(destructiveKind("delete from orders where id = 1"), null);
  assert.equal(destructiveKind("UPDATE t SET a = 1")?.kind, "update-all");
  assert.equal(destructiveKind("update t set a = 1 where id = 2"), null);
  assert.equal(destructiveKind("-- drop table x\nselect * from t"), null);
  assert.equal(destructiveKind("SELECT * FROM t"), null);
});

test("read-only check agrees with the backend's", () => {
  for (const q of ["SELECT * FROM t", "show tables", "select 'insert into x'", "-- drop\nselect 1", "with x as (select 1) select * from x", "EXPLAIN SELECT 1", ""]) assert.ok(isReadOnlySql(q), q);
  for (const q of ["insert into t values (1)", "select 1; delete from t", "select * into n from t", "explain analyze delete from t", "SET x = 1", "with d as (delete from t returning *) select * from d", "pragma journal_mode = off", "drop table t"]) assert.ok(!isReadOnlySql(q), q);
});

test("safety level falls back to the legacy flag, then the environment", () => {
  assert.equal(safetyLevel({ safety: "readonly" }), "readonly");
  assert.equal(safetyLevel({ protect: true }), "protected");
  assert.equal(safetyLevel({ protect: false, environment: "production" }), "off");
  assert.equal(safetyLevel({ environment: "production" }), "protected");
  assert.equal(safetyLevel({ environment: "local" }), "off");
});

test("bulk truncate and drop", () => {
  const a = { schema: null, name: "a" }, b = { schema: null, name: "b" }, v = { schema: null, name: "v", kind: "view" };
  assert.deepEqual(truncateTablesSql("mysql", [a, b, v], true), ["SET FOREIGN_KEY_CHECKS=0", "TRUNCATE TABLE `a`", "TRUNCATE TABLE `b`", "SET FOREIGN_KEY_CHECKS=1"]);
  assert.deepEqual(truncateTablesSql("mysql", [a, b]), ["TRUNCATE TABLE `a`", "TRUNCATE TABLE `b`"]);
  assert.deepEqual(truncateTablesSql("sqlite", [a, b], true), ["PRAGMA foreign_keys=OFF", 'DELETE FROM "a"', 'DELETE FROM "b"', "PRAGMA foreign_keys=ON"]);
  assert.deepEqual(truncateTablesSql("postgres", [a, { schema: "s", name: "b" }], true), ['TRUNCATE TABLE "a", "s"."b" CASCADE']);
  assert.deepEqual(truncateTablesSql("mysql", [v]), []);
  assert.deepEqual(dropTablesSql("mysql", [a, v, b], true), ["SET FOREIGN_KEY_CHECKS=0", "DROP VIEW `v`", "DROP TABLE `a`", "DROP TABLE `b`", "SET FOREIGN_KEY_CHECKS=1"]);
  assert.deepEqual(dropTablesSql("postgres", [a, v, b]), ['DROP VIEW "v"', 'DROP TABLE "a", "b"']);
  assert.deepEqual(dropTablesSql("postgres", [a], true), ['DROP TABLE "a" CASCADE']);
  assert.deepEqual(dropTablesSql("mssql", [a, b]), ["DROP TABLE [a]", "DROP TABLE [b]"]);
  assert.deepEqual(dropTablesSql("mysql", [v], true), ["DROP VIEW `v`"]);
});
