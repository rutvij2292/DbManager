import test from "node:test";
import assert from "node:assert/strict";
import { prettyJson, minifyJson, imageMime, bytesToText, hexDump, formatSize, viewOf } from "../.test-build/cellview.mjs";
import { makeMatcher } from "../.test-build/findreplace.mjs";

const show = (v) => String(v.v);

test("prettyJson only formats objects and arrays", () => {
  assert.equal(prettyJson('{"a":1,"b":[2]}'), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  assert.equal(prettyJson("42"), null);
  assert.equal(prettyJson('"x"'), null);
  assert.equal(prettyJson("{not json"), null);
  assert.equal(minifyJson('{ "a": 1 }'), '{"a":1}');
  assert.equal(minifyJson("{x"), null);
});

test("image types are recognised from magic bytes", () => {
  assert.equal(imageMime([0x89, 0x50, 0x4e, 0x47, 1]), "image/png");
  assert.equal(imageMime([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg");
  assert.equal(imageMime([0x47, 0x49, 0x46, 0x38]), "image/gif");
  assert.equal(imageMime([1, 2, 3]), null);
  assert.equal(imageMime([]), null);
});

test("bytes: text when valid UTF-8, null for binary", () => {
  assert.equal(bytesToText([104, 105, 10]), "hi\n");
  assert.equal(bytesToText([0, 1, 2]), null);
  assert.equal(bytesToText([0xff, 0xfe, 0x41]), null);
});

test("hexDump layout and truncation", () => {
  const d = hexDump([72, 105, 0, 255]);
  assert.match(d, /^00000000  48 69 00 ff/);
  assert.ok(d.endsWith("Hi.."));
  assert.match(hexDump(new Array(40).fill(65), 16), /… 24 more bytes$/);
});

test("formatSize", () => {
  assert.equal(formatSize(1), "1 byte");
  assert.equal(formatSize(2048), "2.0 KB");
});

test("viewOf picks a presentation", () => {
  assert.equal(viewOf({ t: "Null" }, show).kind, "null");
  assert.equal(viewOf({ t: "Text", v: '{"a":1}' }, show).kind, "json");
  assert.equal(viewOf({ t: "Text", v: "plain" }, show).kind, "text");
  assert.equal(viewOf({ t: "I64", v: 5 }, show).kind, "text");
  assert.equal(viewOf({ t: "Bytes", v: [0x89, 0x50, 0x4e, 0x47] }, show).kind, "image");
  assert.equal(viewOf({ t: "Bytes", v: [0, 1] }, show).kind, "bytes");
});

test("matcher: plain, case, whole cell", () => {
  const m = makeMatcher("a.b", { caseSensitive: false, wholeCell: false, regex: false });
  assert.ok(m.test("xA.Bx"));
  assert.ok(!m.test("axb"));
  assert.equal(m.replace("a.b a.b", "$1"), "$1 $1"); // literal replacement
  assert.ok(!makeMatcher("a", { caseSensitive: true, wholeCell: false, regex: false }).test("A"));
  const w = makeMatcher("foo", { caseSensitive: false, wholeCell: true, regex: false });
  assert.ok(w.test("FOO")); assert.ok(!w.test("foo bar"));
  assert.equal(w.replace("foo", "x"), "x");
});

test("matcher: regex groups, errors, empty", () => {
  const m = makeMatcher("(\\d+)-(\\d+)", { caseSensitive: false, wholeCell: false, regex: true });
  assert.equal(m.replace("10-20", "$2/$1"), "20/10");
  assert.ok(m.test("a 1-2")); assert.ok(m.test("a 1-2")); // repeated use is stable (lastIndex reset)
  assert.ok(makeMatcher("(", { caseSensitive: false, wholeCell: false, regex: true }).error);
  const e = makeMatcher("", { caseSensitive: false, wholeCell: false, regex: false });
  assert.ok(!e.test("anything"));
});
