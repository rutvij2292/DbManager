/** User customisation: fonts, editor size, background colour and rebindable keyboard shortcuts. Stored in localStorage; no dependencies. */
import { currentTheme, esc, modal, toast } from "./ui";

export interface Settings {
  uiFont: string;
  editorFont: string;
  editorSize: number;
  bgLight: string;
  bgDark: string;
  keys: Record<string, string>;
}
const KEY = "tabnix.settings";
export const DEFAULT_EDITOR_SIZE = 13.5;
const blank = (): Settings => ({ uiFont: "", editorFont: "", editorSize: DEFAULT_EDITOR_SIZE, bgLight: "", bgDark: "", keys: {} });

let cache: Settings | null = null;
export function settings(): Settings {
  if (!cache) {
    try { cache = { ...blank(), ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { cache = blank(); }
    cache!.keys ||= {};
  }
  return cache!;
}
function save() { localStorage.setItem(KEY, JSON.stringify(settings())); }

// ---------- Appearance ----------
export const UI_FONTS = ["Helvetica Neue", "Avenir Next", "Verdana", "Trebuchet MS", "Georgia", "Optima", "Gill Sans"];
export const EDITOR_FONTS = ["SF Mono", "Menlo", "Monaco", "Courier New", "Andale Mono", "JetBrains Mono", "Fira Code", "Source Code Pro"];
const quote = (f: string) => f.split(",").map((p) => { p = p.trim(); return /^[\w-]+$/.test(p) ? p : `"${p.replace(/["\\]/g, "")}"`; }).join(", ");

/** Relative luminance 0..1 of #rrggbb. */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const isHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);
const BG_VARS = ["--canvas", "--panel", "--raised", "--raised2", "--line", "--line-strong", "--stripe", "--grid-head", "--glass", "--glass-strong", "--aurora-1", "--aurora-2", "--aurora-3", "--aurora-4"];

export function applyAppearance() {
  const s = settings(), st = document.documentElement.style;
  const set = (k: string, v: string) => v ? st.setProperty(k, v) : st.removeProperty(k);
  set("--ui-font", s.uiFont && quote(s.uiFont) + ", -apple-system, system-ui, sans-serif");
  set("--editor-font", s.editorFont && quote(s.editorFont) + ", Menlo, monospace");
  set("--editor-size", s.editorSize !== DEFAULT_EDITOR_SIZE ? s.editorSize + "px" : "");
  const dark = currentTheme() === "dark", bg = dark ? s.bgDark : s.bgLight;
  if (!isHex(bg)) { BG_VARS.forEach((v) => st.removeProperty(v)); }
  else {
    const mix = (pct: number, w: string) => `color-mix(in srgb, ${bg} ${100 - pct}%, ${w})`;
    const [lift, hi] = dark ? ["#fff", [6, 11, 17, 13, 22, 3, 8]] : ["#000", [0, 5, 10, 8, 15, 0, 3]];
    const v = hi as number[];
    st.setProperty("--canvas", bg);
    st.setProperty("--panel", dark ? mix(v[0], lift) : `color-mix(in srgb, ${bg} 35%, #fff)`);
    st.setProperty("--raised", mix(v[1], lift));
    st.setProperty("--raised2", mix(v[2], lift));
    st.setProperty("--line", mix(v[3], dark ? "#fff" : "#000"));
    st.setProperty("--line-strong", mix(v[4], dark ? "#fff" : "#000"));
    st.setProperty("--stripe", dark ? mix(v[5], "#fff") : `color-mix(in srgb, ${bg} 60%, #fff)`);
    st.setProperty("--grid-head", mix(v[6], dark ? "#fff" : "#000"));
    st.setProperty("--glass", `color-mix(in srgb, ${bg} 62%, transparent)`);
    st.setProperty("--glass-strong", `color-mix(in srgb, ${bg} 86%, transparent)`);
    for (let i = 1; i <= 4; i++) st.setProperty(`--aurora-${i}`, "transparent");
  }
  window.dispatchEvent(new Event("resize")); // CodeMirror re-measures after font changes
}

// ---------- Shortcuts ----------
export interface Action { id: string; label: string; group: string; combo: string }
const A = (group: string, id: string, label: string, combo: string): Action => ({ id, label, group, combo });
/** Combos are "ctrl+meta+alt+shift+key", the key being the physical key (so ⌥ combos work on macOS). */
export const ACTIONS: Action[] = [
  A("Queries", "run", "Run statement / selection", "meta+enter"),
  A("Queries", "runAll", "Run all statements", "meta+shift+enter"),
  A("Queries", "cancel", "Cancel running query", "meta+."),
  A("Queries", "explain", "Explain query", "meta+e"),
  A("Queries", "explainAnalyze", "Explain analyze", "meta+shift+e"),
  A("Queries", "builder", "Toggle query builder", "meta+b"),
  A("Queries", "favorite", "Add query to favorites", "meta+shift+s"),
  A("Tabs", "newQuery", "New query tab", "meta+t"),
  A("Tabs", "closeTab", "Close tab", "meta+w"),
  A("Tabs", "nextTab", "Next tab", "meta+shift+]"),
  A("Tabs", "prevTab", "Previous tab", "meta+shift+["),
  A("Tabs", "reload", "Reload data", "meta+r"),
  A("Table", "commit", "Commit changes", "meta+s"),
  A("Table", "discard", "Discard uncommitted changes", "meta+alt+z"),
  A("Table", "commitAll", "Commit all tables in this database", "meta+alt+s"),
  A("Table", "addRow", "Insert row", "meta+i"),
  A("Table", "deleteRow", "Delete selected row", "meta+backspace"),
  A("Table", "filterTable", "Filter rows", "meta+f"),
  A("Navigate", "palette", "Quick open", "meta+p"),
  A("Navigate", "openConnections", "Connections", "meta+o"),
  A("Navigate", "newConnection", "New connection", "meta+n"),
  A("Navigate", "dbPicker", "Open another database", "meta+k"),
  A("Navigate", "focusFilter", "Focus sidebar filter", "meta+l"),
  A("Navigate", "diagram", "Database diagram", "meta+shift+d"),
  A("Navigate", "toggleLog", "SQL log", "meta+j"),
  A("Data", "export", "Export result", "meta+alt+e"),
  A("Data", "import", "Import a file", "meta+alt+i"),
  A("Data", "backup", "Back up database", "meta+alt+b"),
  A("Data", "restore", "Restore a backup", "meta+alt+r"),
  A("App", "theme", "Switch light / dark theme", "meta+shift+l"),
  A("App", "settings", "Settings", "meta+,"),
];
/** True while the dialog is recording a new shortcut, so the global handler must stay quiet. */
export let capturing = false;
export const comboOf = (id: string) => settings().keys[id] ?? ACTIONS.find((a) => a.id === id)!.combo;

const CODES: Record<string, string> = { Period: ".", Comma: ",", Slash: "/", Semicolon: ";", Quote: "'", Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Enter: "enter", Backspace: "backspace", Space: "space", Tab: "tab", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
/** Canonical combo for a keydown, or null for a bare modifier / unknown key. */
export function eventCombo(e: KeyboardEvent): string | null {
  let key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d{1,2}$/.test(e.code) ? e.code.toLowerCase() : CODES[e.code];
  if (!key) return null;
  return [e.ctrlKey && "ctrl", e.metaKey && "meta", e.altKey && "alt", e.shiftKey && "shift", key].filter(Boolean).join("+");
}
const GLYPH: Record<string, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘", enter: "↵", backspace: "⌫", space: "Space", tab: "⇥", up: "↑", down: "↓", left: "←", right: "→" };
const MOD_ORDER = ["ctrl", "alt", "shift", "meta"]; // macOS display order: ⌃⌥⇧⌘
export const prettyCombo = (c: string) => {
  const p = c.split("+"), key = p.pop()!;
  return MOD_ORDER.filter((m) => p.includes(m)).map((m) => GLYPH[m]).join("") + (GLYPH[key] ?? key.toUpperCase());
};

let table: Map<string, string> | null = null;
function lookup() {
  if (!table) table = new Map(ACTIONS.map((a) => [comboOf(a.id), a.id]));
  return table;
}
/** The action bound to this keydown (only combos with ⌘, ⌃ or ⌥ ever match). */
export function matchAction(e: KeyboardEvent): string | null {
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return null;
  const c = eventCombo(e);
  return c ? lookup().get(c) ?? null : null;
}
/** Fixed shortcuts shown for reference in the dialog. */
const FIXED: [string, string][] = [["Switch to tab 1–9", "⌘1 … ⌘9"], ["Copy selected rows", "⌘C"], ["Select all rows", "⌘A"], ["Stop running query / close dialog", "Esc"]];

// ---------- Dialog ----------
export function showSettings() {
  const s = settings();
  const opt = (l: string[]) => l.map((f) => `<option value="${esc(f)}">`).join("");
  const colorRow = (id: "bgLight" | "bgDark", label: string) => `<div class="flex items-center gap-2"><span class="w-[150px] text-soft">${label}</span><input id="${id}" type="color" value="${isHex(s[id]) ? s[id] : id === "bgDark" ? "#0e1418" : "#edf2f5"}" style="width:44px;height:28px;padding:0;border:1px solid var(--line-strong);border-radius:6px;background:none"><button class="btn btn-ghost" data-reset="${id}">Default</button></div>`;
  const m = modal(`
    <div class="px-5 pt-4 pb-2 text-[16px] font-semibold">Settings</div>
    <div class="px-5 pb-4 overflow-auto flex flex-col gap-3 text-[13.5px]">
      <div class="text-[12px] font-semibold uppercase tracking-wide text-muted mt-1">Appearance</div>
      <label class="flex items-center gap-2"><span class="w-[150px] text-soft">Interface font</span><input id="uiFont" class="field flex-1" list="ui-fonts" placeholder="System default" value="${esc(s.uiFont)}"></label>
      <label class="flex items-center gap-2"><span class="w-[150px] text-soft">Editor font</span><input id="editorFont" class="field flex-1" list="ed-fonts" placeholder="SF Mono" value="${esc(s.editorFont)}"></label>
      <label class="flex items-center gap-2"><span class="w-[150px] text-soft">Editor font size</span><input id="editorSize" class="field" type="number" min="9" max="32" step="0.5" style="width:80px" value="${s.editorSize}"><span class="text-muted">px</span></label>
      ${colorRow("bgLight", "Background (light)")}
      ${colorRow("bgDark", "Background (dark)")}
      <datalist id="ui-fonts">${opt(UI_FONTS)}</datalist><datalist id="ed-fonts">${opt(EDITOR_FONTS)}</datalist>
      <div class="text-muted text-[12px]">Type any installed font name. Light and dark backgrounds are kept separate so text stays readable.</div>
      <div class="flex items-center mt-2"><div class="text-[12px] font-semibold uppercase tracking-wide text-muted flex-1">Keyboard shortcuts</div><button id="resetKeys" class="btn btn-ghost">Reset all</button></div>
      <div id="keys" class="flex flex-col"></div>
      <div class="text-muted text-[12px]">Click a shortcut, then press the new keys. Esc cancels. Fixed: ${FIXED.map(([l, k]) => `${esc(l)} (${k})`).join(" · ")}.</div>
    </div>
    <div class="px-5 py-3 flex justify-end border-t border-line"><button id="done" class="btn btn-primary">Done</button></div>`, 640);
  const q = m.q;

  const on = (id: string, fn: (v: string) => void) => { q<HTMLInputElement>("#" + id).oninput = (e) => fn((e.target as HTMLInputElement).value); };
  on("uiFont", (v) => { s.uiFont = v.trim(); save(); applyAppearance(); });
  on("editorFont", (v) => { s.editorFont = v.trim(); save(); applyAppearance(); });
  on("editorSize", (v) => { const n = parseFloat(v); if (n >= 9 && n <= 32) { s.editorSize = n; save(); applyAppearance(); } });
  for (const id of ["bgLight", "bgDark"] as const) {
    on(id, (v) => {
      const dark = id === "bgDark";
      if (dark !== luminance(v) < 0.5) { toast(dark ? "Pick a darker color for the dark theme." : "Pick a lighter color for the light theme.", "info"); return; }
      s[id] = v; save(); applyAppearance();
    });
  }
  m.o.querySelectorAll<HTMLElement>("[data-reset]").forEach((b) => b.onclick = () => { s[b.dataset.reset as "bgLight"] = ""; save(); applyAppearance(); });

  let recording: string | null = null;
  const stop = () => { recording = null; capturing = false; };
  const drawKeys = () => {
    let group = "";
    q("#keys").innerHTML = ACTIONS.map((a) => {
      const head = a.group !== group ? `<div class="text-[12px] text-muted mt-2 mb-0.5">${(group = a.group)}</div>` : "";
      const custom = comboOf(a.id) !== a.combo;
      return `${head}<div class="flex items-center gap-2 h-8"><span class="flex-1">${esc(a.label)}</span><button class="btn ${recording === a.id ? "btn-primary" : ""}" data-rec="${a.id}" style="min-width:96px;justify-content:center">${recording === a.id ? "Press keys…" : prettyCombo(comboOf(a.id))}</button><button class="btn btn-ghost" data-undo="${a.id}" title="Reset to ${prettyCombo(a.combo)}" style="visibility:${custom ? "visible" : "hidden"}">Reset</button></div>`;
    }).join("");
  };
  const rebuild = () => { table = null; };
  q("#keys").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const rec = t.closest<HTMLElement>("[data-rec]"), undo = t.closest<HTMLElement>("[data-undo]");
    if (rec) { recording = rec.dataset.rec!; capturing = true; drawKeys(); }
    else if (undo) { delete s.keys[undo.dataset.undo!]; save(); rebuild(); drawKeys(); }
  });
  q("#resetKeys").onclick = () => { s.keys = {}; save(); rebuild(); drawKeys(); };
  m.blockEsc = () => recording !== null;
  const onKey = (e: KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.key === "Escape") { stop(); drawKeys(); return; }
    const c = eventCombo(e);
    if (!c) return; // bare modifier: wait for the real key
    if (!e.metaKey && !e.ctrlKey && !e.altKey) { toast("Include ⌘, ⌃ or ⌥ in the shortcut.", "info"); return; }
    const clash = ACTIONS.find((a) => a.id !== recording && comboOf(a.id) === c);
    if (clash) { toast(`${prettyCombo(c)} is already used by “${clash.label}”.`, "error"); return; }
    const a = ACTIONS.find((x) => x.id === recording)!;
    if (c === a.combo) delete s.keys[a.id]; else s.keys[a.id] = c;
    save(); rebuild(); stop(); drawKeys();
  };
  window.addEventListener("keydown", onKey, true);
  q("#done").onclick = m.close;
  m.onClose = () => { window.removeEventListener("keydown", onKey, true); capturing = false; };
  drawKeys();
}
