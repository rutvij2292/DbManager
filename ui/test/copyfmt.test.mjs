import { test } from "node:test";
import assert from "node:assert/strict";
import { extendRange, formatRows, nextSelection } from "../.test-build/copyfmt.mjs";

const T = (v) => ({ t: "Text", v }), I = (v) => ({ t: "I64", v }), N = { t: "Null" };
const rows = [[I(1), T('a "q", b'), N], [I(2), T("it's\nnew"), { t: "Bool", v: true }]];
const cols = ["id", "name", "flag"];

test("csv quotes and escapes", () => {
  assert.equal(formatRows("csv", rows, { columns: cols }), 'id,name,flag\n1,"a ""q"", b",\n2,"it\'s\nnew",true');
  assert.equal(formatRows("csv", rows, { columns: cols, header: false }).split("\n")[0], '1,"a ""q"", b",');
});

test("tsv keeps one line per row", () => {
  assert.equal(formatRows("tsv", rows, { columns: cols }), '1\ta "q", b\t\n2\tit\'s new\ttrue');
  assert.ok(formatRows("tsv", rows, { columns: cols, header: true }).startsWith("id\tname\tflag\n"));
});

test("json keeps types and nulls", () => {
  assert.deepEqual(JSON.parse(formatRows("json", rows, { columns: cols })), [{ id: 1, name: 'a "q", b', flag: null }, { id: 2, name: "it's\nnew", flag: true }]);
});

test("markdown escapes pipes", () => {
  const md = formatRows("markdown", [[T("a|b")]], { columns: ["x"] });
  assert.equal(md, "| x |\n| --- |\n| a\\|b |");
});

test("sql insert quotes per dialect", () => {
  const q = (s) => "`" + s + "`";
  assert.equal(formatRows("sql", [[I(1), T("it's \\ x"), N]], { columns: cols, table: "t", quote: q, dialect: "mysql" }), "INSERT INTO `t` (`id`, `name`, `flag`) VALUES\n  (1, 'it''s \\\\ x', NULL);");
  assert.match(formatRows("sql", [[{ t: "Bytes", v: [1, 255] }]], { columns: ["b"], dialect: "postgres" }), /'\\x01ff'/);
  const many = Array.from({ length: 1001 }, (_, i) => [I(i)]);
  assert.equal(formatRows("sql", many, { columns: ["id"] }).split("INSERT INTO").length - 1, 3, "500 rows per statement");
});

test("selection: click, toggle, range", () => {
  let s = nextSelection(new Set(), -1, 3, "single");
  assert.deepEqual([...s.rows], [3]);
  s = nextSelection(s.rows, s.anchor, 6, "range");
  assert.deepEqual([...s.rows], [3, 4, 5, 6]);
  s = nextSelection(s.rows, s.anchor, 5, "toggle");
  assert.deepEqual([...s.rows].sort(), [3, 4, 6]);
  s = nextSelection(s.rows, 9, 7, "range");
  assert.deepEqual([...s.rows].sort(), [7, 8, 9]);
});

test("Shift+Arrow grows the range from a fixed anchor, and shrinks it back", () => {
  let s = extendRange(2, 2, 1, 10);
  assert.deepEqual([...s.rows], [2, 3]);
  s = extendRange(2, s.cursor, 1, 10);
  assert.deepEqual([...s.rows], [2, 3, 4]);
  s = extendRange(2, s.cursor, -1, 10);
  assert.deepEqual([...s.rows], [2, 3]);
  s = extendRange(2, 2, -1, 10);
  assert.deepEqual([...s.rows], [1, 2]);
  assert.equal(s.cursor, 1);
});

test("Shift+Arrow stops at the first and last row", () => {
  assert.deepEqual([...extendRange(0, 0, -1, 5).rows], [0]);
  assert.deepEqual([...extendRange(3, 4, 1, 5).rows], [3, 4]);
  assert.equal(extendRange(3, 4, 1, 5).cursor, 4);
});
