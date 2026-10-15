import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSelect, resolveEdit } from "../.test-build/resultedit.mjs";

const ok = (sql) => { const a = analyzeSelect(sql); assert.ok(a.ok, sql + " -> " + a.reason); return a; };
const bad = (sql, re) => { const a = analyzeSelect(sql); assert.ok(!a.ok, sql + " should not be editable"); if (re) assert.match(a.reason, re); };
const users = [{ name: "id", primary_key: true }, { name: "name", primary_key: false }, { name: "email", primary_key: false }];

test("plain selects are editable", () => {
  assert.equal(ok("SELECT * FROM users").table, "users");
  assert.equal(ok("select * from users where id > 3 order by name limit 10;").table, "users");
  const a = ok('SELECT u.id, u."name" AS n, email e FROM public.users AS u WHERE u.id = 1');
  assert.equal(a.schema, "public");
  assert.deepEqual(a.items, [{ col: "id" }, { col: "name" }, { col: "email" }]);
  assert.equal(ok("SELECT TOP 10 * FROM [dbo].[users]").table, "users");
  assert.equal(ok("SELECT `id` FROM `users` -- c").table, "users");
  assert.deepEqual(ok("SELECT u.* FROM users u").items, [{ star: true }]);
});

test("expressions are read-only columns, not rejections", () => {
  const a = ok("SELECT id, name || '!' AS n, lower(email), id + 1, 'x', CASE WHEN id > 1 THEN 1 END FROM users");
  assert.deepEqual(a.items.map((i) => i.col), ["id", null, null, null, null, null]);
});

test("unsafe shapes are refused with a reason", () => {
  bad("SELECT * FROM a JOIN b ON a.id = b.id", /joins/);
  bad("SELECT * FROM a LEFT JOIN b ON a.id = b.id", /joins/);
  bad("SELECT * FROM a, b", /more than one/);
  bad("SELECT DISTINCT name FROM users", /DISTINCT/);
  bad("SELECT name, count(*) FROM users GROUP BY name", /GROUP BY|COUNT/);
  bad("SELECT count(*) FROM users", /COUNT/);
  bad("SELECT * FROM users UNION SELECT * FROM users", /UNION/);
  bad("SELECT * FROM (SELECT * FROM users) x", /plain table/);
  bad("WITH x AS (SELECT 1) SELECT * FROM x", /plain SELECT/);
  bad("UPDATE users SET a = 1", /plain SELECT/);
  bad("SELECT 1", /FROM/);
  bad("SELECT * FROM users; SELECT * FROM users", /more than one/);
  bad("SELECT o.* FROM users u", /isn't this table/);
  bad("SELECT x.id FROM users u", /isn't this table/);
  bad("SELECT * FROM users INTO OUTFILE 'x'", /INTO/);
});

test("strings and comments don't confuse it", () => {
  ok("SELECT * FROM users WHERE name = 'a join b' -- group by");
  ok("SELECT /* join */ id FROM users WHERE x IN (SELECT y FROM z)");
});

test("resolveEdit maps columns and demands the primary key", () => {
  let r = resolveEdit(ok("SELECT * FROM users"), ["id", "name", "email"], users);
  assert.ok(r.ok); assert.deepEqual(r.map, ["id", "name", "email"]);
  r = resolveEdit(ok("SELECT id, name AS n, upper(email) FROM users"), ["id", "n", "upper"], users);
  assert.ok(r.ok); assert.deepEqual(r.map, ["id", "name", null]);
  r = resolveEdit(ok("SELECT name FROM users"), ["name"], users);
  assert.ok(!r.ok); assert.match(r.reason, /primary key \(id\)/);
  r = resolveEdit(ok("SELECT id, id AS again FROM users"), ["id", "again"], users);
  assert.ok(r.ok); assert.deepEqual(r.map, ["id", null]);
  r = resolveEdit(ok("SELECT ID, NAME FROM users"), ["ID", "NAME"], users);
  assert.ok(r.ok); assert.deepEqual(r.map, ["id", "name"]);
  r = resolveEdit(ok("SELECT * FROM users"), ["id", "name"], users);
  assert.ok(!r.ok);
  r = resolveEdit(ok("SELECT * FROM users"), ["a"], [{ name: "a", primary_key: false }]);
  assert.ok(!r.ok); assert.match(r.reason, /no primary key/);
});
