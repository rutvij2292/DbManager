import { test } from "node:test";
import assert from "node:assert/strict";
import { bandRange } from "../.test-build/stmtband.mjs";

test("the band covers the statement the cursor is in, without surrounding blank space", () => {
  const doc = "select 1;\n\n  select 2\n  from t;\n";
  assert.deepEqual(bandRange(doc, 3), { from: 0, to: 8 });
  const second = bandRange(doc, doc.indexOf("from") + 1);
  assert.equal(doc.slice(second.from, second.to), "select 2\n  from t");
});

test("a cursor right behind the semicolon still belongs to that statement", () => {
  const doc = "select 1;";
  assert.deepEqual(bandRange(doc, doc.length), { from: 0, to: 8 });
});

test("a single statement without a semicolon is covered; an empty editor has no band", () => {
  assert.deepEqual(bandRange("select 1", 2), { from: 0, to: 8 });
  assert.equal(bandRange("", 0), null);
  assert.equal(bandRange("   \n ", 2), null);
});

test("a comment-only editor has no band", () => {
  assert.equal(bandRange("-- nothing yet", 3), null);
});
