import { test } from "node:test";
import assert from "node:assert/strict";
import { diffColumns } from "../.test-build/structure.mjs";

const orig = (name, type_name = "INT", nullable = true, def = null, pk = false) => ({ name, type_name, nullable, default: def, primary_key: pk });
const row = (o, over = {}) => ({ orig: o, name: o?.name ?? "", type: o?.type_name ?? "TEXT", nullable: o?.nullable ?? true, def: o?.default ?? "", dropped: false, ...over });

test("untouched rows produce no changes", () => {
  assert.deepEqual(diffColumns([row(orig("id", "INT", false, null, true)), row(orig("name", "TEXT"))]), []);
});

test("rename, retype, nullability and default are detected", () => {
  const out = diffColumns([row(orig("age", "INT", false, "0"), { name: "years", type: "BIGINT", nullable: true, def: "" })]);
  assert.deepEqual(out.map((c) => c.kind), ["rename_column", "alter_column"]);
  assert.deepEqual(out[0], { kind: "rename_column", from: "age", to: "years" });
  // The alter targets the new name and records the old definition so the generator emits only what changed.
  assert.equal(out[1].name, "years");
  assert.deepEqual([out[1].old_type, out[1].old_nullable, out[1].old_default, out[1].default], ["INT", false, "0", null]);
});

test("added and dropped columns", () => {
  const out = diffColumns([
    row(orig("a"), { dropped: true }),
    row(null, { name: " nickname ", type: "VARCHAR(20)", nullable: false, def: "'x'" }),
    row(null, { name: "   " }),                         // blank new rows are ignored
    row(null, { name: "gone", dropped: true }),         // new-then-dropped never reaches the database
  ]);
  assert.deepEqual(out, [
    { kind: "drop_column", name: "a" },
    { kind: "add_column", name: "nickname", type_name: "VARCHAR(20)", nullable: false, default: "'x'" },
  ]);
});

test("whitespace-only default edits are not changes", () => {
  assert.deepEqual(diffColumns([row(orig("a", "INT", true, "0"), { def: " 0 " })]), []);
});
