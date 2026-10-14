import { test } from "node:test";
import assert from "node:assert/strict";
globalThis.localStorage = { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = v; } };
const { ACTIONS, eventCombo, matchAction, prettyCombo, luminance, settings } = await import("../.test-build/settings.mjs");
const ev = (code, mods = {}) => ({ code, key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("default combos are unique", () => {
  assert.equal(new Set(ACTIONS.map((a) => a.combo)).size, ACTIONS.length);
});
test("matches physical keys, including ⌥ and shifted brackets", () => {
  assert.equal(matchAction(ev("KeyT", { metaKey: true })), "newQuery");
  assert.equal(matchAction(ev("KeyE", { metaKey: true, altKey: true })), "export");
  assert.equal(matchAction(ev("BracketRight", { metaKey: true, shiftKey: true })), "nextTab");
  assert.equal(matchAction(ev("Enter", { metaKey: true, shiftKey: true })), "runAll");
});
test("keys without ⌘/⌃/⌥ never match", () => {
  assert.equal(matchAction(ev("KeyT")), null);
  assert.equal(matchAction(ev("KeyT", { shiftKey: true })), null);
});
test("overrides take effect", () => {
  settings().keys.newQuery = "meta+shift+y";
  assert.equal(eventCombo(ev("KeyY", { metaKey: true, shiftKey: true })), "meta+shift+y");
});
test("pretty + luminance", () => {
  assert.equal(prettyCombo("meta+shift+enter"), "⇧⌘↵");
  assert.ok(luminance("#ffffff") > 0.99 && luminance("#000000") === 0);
});
