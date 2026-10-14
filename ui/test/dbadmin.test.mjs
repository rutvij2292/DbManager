import { test } from "node:test";
import assert from "node:assert/strict";
import { createDatabaseSql, dropDatabaseSql, truncateAllSql, truncateTableSql, dropTableSql } from "../.test-build/dbadmin.mjs";

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

test("single table", () => {
  assert.equal(truncateTableSql("mysql", { schema: null, name: "a" }), "TRUNCATE TABLE `a`");
  assert.equal(truncateTableSql("sqlite", { schema: null, name: "a" }), 'DELETE FROM "a"');
  assert.equal(dropTableSql("postgres", { schema: "s", name: "v", kind: "view" }), 'DROP VIEW "s"."v"');
});
