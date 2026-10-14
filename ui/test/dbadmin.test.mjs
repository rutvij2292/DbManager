import { test } from "node:test";
import assert from "node:assert/strict";
import { createDatabaseSql, dropDatabaseSql, truncateAllSql, truncateTableSql, dropTableSql, isForeignKeyError } from "../.test-build/dbadmin.mjs";

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
