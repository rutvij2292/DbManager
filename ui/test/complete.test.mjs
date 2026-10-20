import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { makeCompletionSource } = await import("../.test-build/complete.mjs");

const tables = [
  { schema: null, name: "orders", columns: ["id", "customer_id", "status", "total"] },
  { schema: null, name: "customers", columns: ["id", "name", "email"] },
];
const source = makeCompletionSource(() => tables);

/** Completion at the end of `doc` (or at `|` if present), as if the user pressed Ctrl-Space. */
function at(docWithCursor) {
  const pos = docWithCursor.includes("|") ? docWithCursor.indexOf("|") : docWithCursor.length;
  const doc = docWithCursor.replace("|", "");
  const ctx = {
    pos, explicit: true, state: { doc: { toString: () => doc } },
    matchBefore(re) {
      const before = doc.slice(0, pos);
      const m = new RegExp(`(?:${re.source})$`).exec(before);
      return m && (m[0] !== "" || re.source.includes("*")) ? { from: pos - m[0].length, to: pos, text: m[0] } : null;
    },
  };
  return source(ctx);
}
const labels = (r) => r.options.map((o) => o.label);

test("COUNT(DISTINCT before any FROM still offers columns, from every table", () => {
  const l = labels(at("SELECT COUNT(DISTINCT "));
  for (const c of ["customer_id", "status", "total", "name", "email", "id"]) assert.ok(l.includes(c), `missing column ${c}`);
  assert.equal(l.filter((x) => x === "id").length, 1, "a column shared by two tables is listed once");
});

test("a column shared by tables says so", () => {
  const id = at("SELECT ").options.find((o) => o.label === "id");
  assert.match(id.detail, /orders/);
  assert.match(id.detail, /customers/);
});

test("table names are offered before FROM, so table.column can be typed", () => {
  const l = labels(at("SELECT "));
  assert.ok(l.includes("orders") && l.includes("customers"));
});

test("table. gives that table's columns even without a FROM", () => {
  assert.deepEqual(labels(at("SELECT COUNT(DISTINCT orders.")), ["id", "customer_id", "status", "total"]);
});

test("once there is a FROM, only that table's columns are offered", () => {
  const l = labels(at("SELECT COUNT(DISTINCT | FROM orders"));
  assert.ok(l.includes("status"));
  assert.ok(!l.includes("email"), "customers.email is not in scope");
});

test("after FROM the tables are offered", () => {
  assert.ok(labels(at("SELECT 1 FROM ")).includes("orders"));
});
