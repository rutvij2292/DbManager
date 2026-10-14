import "./style.css";
import { installMock } from "./mock";
// Dev only: `?mock` renders the UI without the Rust backend. Stripped from production builds.
if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) installMock();
import { open } from "@tauri-apps/plugin-dialog";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { autocompletion, completionKeymap, pickedCompletion } from "@codemirror/autocomplete";
import { createBuilder } from "./builder";
import { showExport, showImport } from "./io";
import { createStructureView } from "./structure";
import { createFilterBar } from "./filterbar";
import { lintSql, lintPlan } from "./lint";
import { renderPlan, hintsPanel } from "./planview";
import { makeCompletionSource, recordAccepted } from "./complete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { sql, SQLite, PostgreSQL, MySQL, MSSQL } from "@codemirror/lang-sql";
import { api, type ObjectRef, type Summary, type Profile, type SchemaTable, type ColumnInfo, type Change, type Val } from "./api";
import { showConnectionManager } from "./connections";
import { icon, engineBadge, engineVar, envColor, isCareful, ENGINE_NAMES } from "./icons";
import { applyTheme, currentTheme, esc, toast, contextMenu, tagChip, tagHue as tagHueOf } from "./ui";
import { showTablePlusImport } from "./tpimport";
import { tabsOf, nextAfterClose, nthTab, cycleTab, tabForSwitch } from "./workspace";
import { pickDatabase } from "./dbpicker";
import { createDiagram } from "./diagram";
import { showBackup, showRestore, BACKUP_KINDS } from "./backup";
import { Grid } from "./grid";

/** One open database: its own backend connection, tables and completion schema. */
interface Conn { id: number; name: string; kind: string; env?: string | null; sub?: string; db?: string | null; dbs?: string[]; objects: ObjectRef[]; schema: SchemaTable[]; server: Server; loading?: boolean }
/** A saved connection that is currently connected, with the databases opened on it. */
interface Server { id: string; name: string; kind: string; env?: string | null; profile: Profile; rootId: number; dbs: string[]; conns: Conn[]; lastTab?: Tab | null }
interface Tab {
  id: number; title: string; kind: "query" | "table" | "diagram";
  conn: Conn | null; table?: string;
  root: HTMLElement; grid: Grid; panel?: HTMLElement; gridWrap?: HTMLElement; cols?: ColumnInfo[]; schemaName?: string | null; bar?: HTMLElement; builder?: HTMLElement; edWrap?: HTMLElement; running?: boolean; cancelled?: boolean; empty?: HTMLElement; runBar?: HTMLElement; structure?: ReturnType<typeof createStructureView>; mode?: "data" | "structure"; filterBar?: ReturnType<typeof createFilterBar>; filterWhere?: string; filterBtn?: HTMLElement; editor?: EditorView; status: HTMLElement;
}

/** The current workspace: the database the sidebar last selected or the active tab belongs to. */
let conn: Conn | null = null;
const servers: Server[] = [];
/** The connection whose workspace is on screen. Tabs, sidebar and shortcuts only ever see this one. */
let activeServer: Server | null = null;
let launcherOpen = false;
/** Home-screen tag filter: "all", a tag name, or "__none" for connections without tags. */
let launcherTag = "all";
/** Tabs that belong to a connection. This is the only list the UI may iterate: connections never share tabs. */
const serverTabs = (s: Server | null = activeServer): Tab[] => tabsOf(tabs, s);
const tabs: Tab[] = [];
let active: Tab | null = null;
let tabSeq = 0;
const sqlLang = new Compartment();
const sqlHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--tok-keyword)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "var(--tok-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--tok-number)" },
  { tag: [t.lineComment, t.blockComment], color: "var(--tok-comment)", fontStyle: "italic" },
  { tag: [t.typeName, t.standard(t.typeName)], color: "var(--tok-type)" },
  { tag: [t.function(t.variableName), t.standard(t.name)], color: "var(--tok-fn)" },
  { tag: [t.punctuation, t.operator], color: "var(--soft)" },
]);

function langFor(c: Conn | null) {
  const dialect = c?.kind === "sqlite" ? SQLite : c?.kind === "mssql" ? MSSQL : c && ["mysql", "mariadb"].includes(c.kind) ? MySQL : PostgreSQL;
  return sql({ dialect, upperCaseKeywords: true });
}

async function formatEditor(view: EditorView, c: Conn | null) {
  // Loaded on first use to keep startup memory small.
  const { format: formatSql } = await import("sql-formatter");
  const language = c?.kind === "sqlite" ? "sqlite" : c?.kind === "mssql" ? "transactsql" : c && ["mysql", "mariadb"].includes(c.kind) ? "mysql" : "postgresql";
  const sel = view.state.selection.main;
  const [from, to] = sel.empty ? [0, view.state.doc.length] : [sel.from, sel.to];
  try {
    const out = formatSql(view.state.sliceDoc(from, to), { language, keywordCase: "upper" });
    view.dispatch({ changes: { from, to, insert: out } });
  } catch { /* leave text untouched when the SQL cannot be parsed */ }
}

const app = document.getElementById("app")!;
applyTheme(currentTheme());
const iconBtn = (id: string, ic: string, title: string) => `<button id="${id}" class="btn btn-ghost" style="width:28px;padding:0;justify-content:center" title="${title}" aria-label="${title}">${icon(ic, 16)}</button>`;
app.innerHTML = `
  <div class="h-full flex gap-2 p-2">
    <nav id="rail" class="w-[78px] shrink-0 glass rounded-2xl flex flex-col items-center" aria-label="Connections">
      <div class="titlebar h-11 shrink-0 w-full"></div>
      <div id="rail-items" class="flex-1 overflow-y-auto overflow-x-visible flex flex-col items-center gap-1 py-1 w-full px-1.5"></div>
      <div class="flex flex-col items-center gap-1 py-2.5">
        <button id="addconn" class="flex flex-col items-center justify-center gap-0.5 rounded-xl" style="width:66px;height:50px" title="Connect to another database (⌘N)" aria-label="Connect to another database">${icon("plus", 18)}<span class="text-[11.5px]">Connect</span></button>
        <button id="theme" class="btn btn-ghost" style="width:34px;height:30px;padding:0;justify-content:center" title="Switch theme (⌘⇧L)" aria-label="Switch theme"></button>
      </div>
    </nav>
    <aside class="w-[272px] shrink-0 glass rounded-2xl flex flex-col min-h-0">
      <div class="titlebar h-11 shrink-0"></div>
      <div class="px-3 mb-2 relative">
        <span class="absolute left-[22px] top-[9px] text-muted pointer-events-none">${icon("search", 15)}</span>
        <input id="filter" placeholder="Search tables" class="field w-full" style="padding-left:34px;background:color-mix(in srgb, var(--panel) 70%, transparent)" />
        <span class="kbd absolute right-[22px] top-[6px] pointer-events-none">⌘P</span>
      </div>
      <div id="objects" class="flex-1 overflow-auto px-2 pb-2"></div>
      <div class="px-3 py-2.5 flex items-center gap-1">
        <button id="open" class="btn btn-ghost flex-1" style="justify-content:flex-start">${icon("plug", 16)}<span>Connections</span><span class="kbd ml-auto">⌘O</span></button>
        <button id="diagram" class="btn btn-ghost" style="width:32px;padding:0;justify-content:center" title="Diagram of this database (⌘⇧D)">${icon("diagram", 16)}</button>
      </div>
    </aside>
    <div class="flex-1 min-w-0 flex flex-col">
      <div class="titlebar h-11 shrink-0 flex items-end px-1 gap-2">
        <div id="tabs" class="flex items-end gap-0.5 overflow-x-auto flex-1 min-w-0 h-full"></div>
        <div class="flex items-center gap-0.5 pb-1.5">
          ${iconBtn("backup", "archive", "Back up this database… (⌘⌥B)")}${iconBtn("restore", "restore", "Restore a backup… (⌘⌥R)")}<span class="w-px h-4 bg-line-strong mx-1"></span>
          ${iconBtn("import", "upload", "Import a file… (⌘⌥I)")}${iconBtn("export", "download", "Export the result… (⌘⌥E)")}${iconBtn("newtab", "plus", "New query tab (⌘T)")}
        </div>
      </div>
      <main id="main" class="card flex-1 min-h-0 flex flex-col" style="border-top-left-radius:0"></main>
    </div>
  </div>
  <div id="palette" class="hidden fixed inset-0 flex items-start justify-center pt-24 z-50" style="background:color-mix(in srgb, var(--ink) 26%, transparent);backdrop-filter:blur(8px)">
    <div class="w-[580px] glass-strong rounded-2xl overflow-hidden">
      <input id="pinput" placeholder="Open a table, view or collection" class="w-full bg-transparent px-5 py-3.5 outline-none border-b border-line text-[16px]"/>
      <div id="plist" class="max-h-80 overflow-auto py-1.5"></div>
    </div>
  </div>`;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function makeTab(kind: Tab["kind"], title: string, table?: string, c: Conn | null = conn): Tab {
  const root = document.createElement("div");
  root.className = "h-full flex flex-col min-h-0";
  const grid = new Grid();
  const status = document.createElement("span");
  status.className = "truncate flex-1 min-w-0";
  const statusBar = document.createElement("div");
  statusBar.className = "h-8 shrink-0 px-4 flex items-center gap-3 text-[13px] text-soft bg-canvas";
  if (c) {
    const risky = c.env === "production" || c.env === "staging";
    statusBar.innerHTML = `<span class="pill shrink-0" style="--hue:${engineVar(c.kind)};background:color-mix(in srgb, ${engineVar(c.kind)} 12%, transparent);color:var(--ink)"><span style="width:7px;height:7px;border-radius:4px;background:${engineVar(c.kind)}"></span>${esc(c.name)}${c.db ? `<span class="text-muted"> / ${esc(c.db)}</span>` : ""}</span>${risky ? `<span class="pill shrink-0" style="color:${envColor(c.env)};background:color-mix(in srgb, ${envColor(c.env)} 12%, transparent)">${esc(c.env!)}</span>` : ""}`;
  }
  statusBar.append(status);
  const tab: Tab = { id: ++tabSeq, title, kind, conn: c, table, root, grid, status };
  if (kind === "query") {
    root.append(queryBar(tab));
    const ed = document.createElement("div");
    ed.className = "h-1/3 min-h-[80px] border-b border-line overflow-hidden";
    tab.editor = new EditorView({
      parent: ed,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(), history(), syntaxHighlighting(sqlHighlight), sqlLang.of(langFor(c)),
          autocompletion({ override: [makeCompletionSource(() => tab.conn?.schema ?? [])], activateOnTyping: true, icons: false }),
          EditorView.updateListener.of((u) => { for (const tr of u.transactions) { const c = tr.annotation(pickedCompletion); if (c) recordAccepted(c.label); } }),
          keymap.of([
            { key: "Mod-Enter", run: () => (runActive(), true) },
            { key: "Mod-i", run: (v) => (formatEditor(v, tab.conn), true) },
            ...completionKeymap, ...defaultKeymap, ...historyKeymap,
          ]),
        ],
      }),
    });
    tab.edWrap = ed;
    root.append(ed);
  }
  const gridWrap = document.createElement("div");
  gridWrap.className = "flex-1 min-h-0 relative";
  gridWrap.append(grid.el);
  if (kind === "query") {
    const empty = document.createElement("div");
    empty.className = "absolute inset-0 flex flex-col items-center justify-center text-center gap-1 pointer-events-none";
    empty.style.background = "var(--panel)";
    empty.innerHTML = `<div style="color:var(--soft)">${ART_RESULTS}</div><div class="text-[16px] font-semibold mt-2">Results appear here</div><div class="text-soft">Write a query above and press <span class="kbd">⌘↵</span> to run it.</div>`;
    gridWrap.append(empty);
    tab.empty = empty;
  }
  tab.gridWrap = gridWrap;
  if (kind === "table") {
    const bar = document.createElement("div");
    bar.className = "h-11 shrink-0 flex items-center gap-1.5 px-3 bg-canvas text-[13.5px]";
    const btn = (label: string, title: string, f: () => void, ic?: string, cls = "btn") => {
      const b = document.createElement("button");
      b.innerHTML = (ic ? icon(ic, 14) : "") + `<span>${label}</span>`;
      b.title = title; b.className = cls; b.onclick = f;
      b.dataset.label = label;
      return b;
    };
    const commit = btn("Commit", "Review & commit changes (⌘S)", () => commitChanges(tab), "commit");
    const discard = btn("Discard", "Discard pending changes", () => grid.discard(), "undo");
    const info = document.createElement("span");
    info.className = "hint text-muted ml-2 truncate";
    const segWrap = document.createElement("div");
    segWrap.className = "seg mr-2";
    const seg = (label: string, mode: "data" | "structure", ic: string) => {
      const b = btn(label, mode === "data" ? "Table data" : "Table structure (columns, indexes, keys)", () => setMode(tab, mode), ic, "");
      b.dataset.mode = mode;
      b.setAttribute("aria-pressed", "false");
      return b;
    };
    segWrap.append(seg("Data", "data", "table"), seg("Structure", "structure", "structure"));
    const sep = document.createElement("span");
    sep.className = "hint w-px h-4 bg-line-strong mx-1";
    const sqlLike = !!c && !["redis", "mongo"].includes(c.kind);
    const filterBtn = btn("Filter", "Filter rows (⌘F)", () => tab.filterBar?.toggle(), "filter", "btn btn-ghost");
    filterBtn.dataset.label = "Filter";
    tab.filterBtn = filterBtn;
    if (sqlLike) {
      tab.filterBar = createFilterBar(
        () => (grid.columns.length ? grid.columns.map((c) => c.name) : (tab.cols ?? []).map((c) => c.name)),
        () => quoteFor(tab.conn),
        (where) => { tab.filterWhere = where || undefined; paintFilter(tab); reload(tab); },
      );
    }
    const diagBtn = btn("Diagram", "Show this table's relations (⌘⇧D)", () => openDiagram(tab.table), "diagram", "btn btn-ghost");
    // Labels drive which buttons are hidden in Structure mode, so set them on the buttons themselves.
    const addRow = btn("Row", "Insert row (⌘I)", () => grid.addRow(), "plus", "btn btn-ghost");
    const delRow = btn("Row", "Delete selected row (⌘⌫)", () => grid.deleteSelected(), "minus", "btn btn-ghost");
    addRow.dataset.label = "+ Row";
    delRow.dataset.label = "− Row";
    bar.append(segWrap, ...(sqlLike ? [filterBtn, diagBtn] : []), addRow, delRow, sep, commit, discard, info);
    const refreshBar = () => {
      const n = grid.pendingCount;
      commit.style.display = discard.style.display = n ? "" : "none";
      commit.querySelector("span")!.textContent = n ? `Commit ${n}` : "Commit";
      commit.className = n ? (isCareful(tab.conn?.env) && tab.conn?.env === "production" ? "btn btn-careful" : "btn btn-primary") : "btn";
      info.textContent = !tab.cols ? "" : grid.editable ? (n ? `${n} pending change${n > 1 ? "s" : ""}` : "Double-click a cell to edit") : "Read-only: this table has no primary key";
    };
    grid.onChange = refreshBar;
    refreshBar();
    setTimeout(() => setMode(tab, "data"), 0);
    tab.bar = bar;
    root.append(bar);
    if (tab.filterBar) root.append(tab.filterBar.el);
  }
  root.append(gridWrap, statusBar);
  tabs.push(tab);
  activate(tab); // also switches the workspace to this tab's connection
  tab.editor?.focus();
  return tab;
}

const quoteFor = (c: Conn | null) => (c?.kind === "mssql" ? (s: string) => "[" + s.replace(/]/g, "]]") + "]" : c && ["mysql", "mariadb"].includes(c.kind) ? (s: string) => "`" + s.replace(/`/g, "``") + "`" : (s: string) => '"' + s.replace(/"/g, '""') + '"');

/** ⌘B: toggle the visual query builder above the editor. */
function toggleBuilder() {
  const t = active;
  if (!t || t.kind !== "query" || !t.editor || !t.edWrap) return;
  if (t.builder) {
    t.builder.remove();
    t.builder = undefined;
    t.edWrap.className = "h-1/3 min-h-[80px] border-b border-line overflow-hidden";
    return;
  }
  t.builder = createBuilder(
    () => t.conn?.schema ?? [],
    () => quoteFor(t.conn),
    (text) => {
      if (!text) return;
      t.editor!.dispatch({ changes: { from: 0, to: t.editor!.state.doc.length, insert: text } });
    },
    () => t.conn?.kind === "mssql",
  );
  t.builder.className += " h-[45%] shrink-0";
  t.root.insertBefore(t.builder, t.edWrap);
  t.edWrap.className = "h-1/4 min-h-[70px] border-b border-line overflow-hidden";
}

function activate(t: Tab) {
  active = t;
  launcherOpen = false;
  if (t.conn) {
    conn = t.conn; // the sidebar and dialogs follow the tab you are working in
    activeServer = t.conn.server;
    t.conn.server.lastTab = t;
  }
  $("main").replaceChildren(t.root);
  renderTabs();
}

/** Switch the whole workspace (tabs, sidebar, current database) to another connection. */
function switchServer(s: Server) {
  activeServer = s;
  launcherOpen = false;
  const target = tabForSwitch(tabs, s, s.lastTab);
  if (target) { activate(target); return; }
  conn = s.conns[0] ?? null;
  active = null;
  renderTabs();
  showHome();
}

function closeTab(t: Tab) {
  const server = t.conn?.server ?? null;
  const g = tabs.indexOf(t);
  if (g < 0) return;
  const next = nextAfterClose(tabs, t); // always a tab of the same connection, or null
  tabs.splice(g, 1);
  t.grid.setResult(null);
  t.editor?.destroy();
  if (server && server.lastTab === t) server.lastTab = null;
  if (active === t) {
    if (next) activate(next);
    else { active = null; renderTabs(); showHome(); }
  } else renderTabs();
}

function renderTabs() {
  const el = $("tabs");
  const mine = serverTabs();
  const multiDb = (activeServer?.conns.length ?? 0) > 1;
  el.replaceChildren(
    ...mine.map((t, i) => {
      const on = t === active;
      const d = document.createElement("div");
      d.className = "group tab";
      d.setAttribute("role", "tab");
      d.setAttribute("aria-selected", String(on));
      if (t.conn) d.style.setProperty("--hue", t.conn.env === "production" ? "var(--env-production)" : engineVar(t.conn.kind));
      d.title = `${t.title}${t.conn?.db ? ` · ${t.conn.db}` : ""}${i < 9 ? `  (⌘${i + 1})` : ""}`;
      const tint = t.kind === "table" ? engineVar(t.conn?.kind) : t.kind === "diagram" ? "var(--eng-mssql)" : "var(--accent)";
      d.innerHTML = `<span style="color:${tint}">${icon(t.kind === "table" ? "table" : t.kind === "diagram" ? "diagram" : "plan", 15)}</span><span class="truncate">${esc(t.title)}</span>` +
        (multiDb && t.conn?.db ? `<span class="text-muted text-[12px] shrink-0 truncate" style="max-width:96px">${esc(t.conn.db)}</span>` : "");
      const x = document.createElement("button");
      x.innerHTML = icon("close", 12);
      x.setAttribute("aria-label", "Close tab");
      x.className = "rounded p-1 text-muted hover:text-ink hover:bg-raised2 " + (on ? "" : "opacity-0 group-hover:opacity-100");
      x.onclick = (e) => { e.stopPropagation(); closeTab(t); };
      d.append(x);
      d.onclick = () => activate(t);
      d.onauxclick = () => closeTab(t);
      return d;
    }),
  );
  renderRail();
  renderObjects();
}

// ---------- connection rail: the narrow strip at the far left that switches between connections ----------
function renderRail() {
  const host = $("rail-items");
  host.replaceChildren(...servers.map((s) => {
    const on = s === activeServer && !launcherOpen;
    const n = serverTabs(s).length;
    const b = document.createElement("button");
    b.className = "relative flex flex-col items-center gap-1 rounded-xl shrink-0 px-1 pt-2 pb-1.5 " + (on ? "glass-strong" : "hover:bg-raised");
    b.style.cssText = "width:66px;transition:background .12s";
    b.setAttribute("aria-label", `${s.name}${on ? " (current)" : ""}`);
    b.title = `${s.name} · ${ENGINE_NAMES[s.kind] ?? s.kind}${s.env && s.env !== "local" ? " · " + s.env : ""}\n${n} tab${n === 1 ? "" : "s"} · ${s.conns.length} database${s.conns.length === 1 ? "" : "s"} open`;
    b.innerHTML = engineBadge(s.kind, 36) +
      `<span class="text-[11.5px] leading-[1.15] text-center w-full ${on ? "text-ink font-medium" : "text-soft"}" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word">${esc(s.name)}</span>` +
      (on ? `<span class="absolute" style="left:-7px;top:18px;width:4px;height:24px;border-radius:0 3px 3px 0;background:var(--hue-active,var(--accent))"></span>` : "") +
      (s.env && s.env !== "local" ? `<span class="absolute" style="right:7px;top:5px;width:10px;height:10px;border-radius:5px;background:${envColor(s.env)};border:2px solid var(--panel)"></span>` : "") +
      (n > 1 ? `<span class="absolute text-[10.5px] font-semibold rounded-full bg-raised2 text-soft" style="right:4px;top:30px;min-width:16px;height:16px;line-height:16px;text-align:center;padding:0 4px">${n}</span>` : "");
    b.onclick = () => switchServer(s);
    b.oncontextmenu = (e) => { e.preventDefault(); serverMenu(s, e.clientX, e.clientY); };
    return b;
  }));
  const plus = $("addconn");
  plus.className = "relative flex flex-col items-center justify-center gap-0.5 rounded-xl " + (launcherOpen ? "glass-strong text-accent" : "text-muted hover:bg-raised hover:text-ink");
}

async function exec(t: Tab, sqlText: string) {
  if (!t.conn) { t.status.textContent = "Not connected — open a database first (⌘O)"; return; }
  if (t.panel && t.gridWrap) { t.gridWrap.replaceChildren(t.grid.el); t.panel = undefined; }
  if (t.running) { t.status.textContent = "A query is already running — ⌘. to cancel"; return; }
  t.running = true; t.cancelled = false;
  t.empty?.remove(); t.empty = undefined;
  if (t.gridWrap) { t.runBar = document.createElement("div"); t.runBar.className = "running-bar"; t.gridWrap.append(t.runBar); }
  t.status.textContent = "Running… (⌘. to cancel)";
  try {
    const s: Summary = await api.runQuery(t.conn.id, sqlText);
    await t.grid.setResult(s.columns.length ? s : null);
    t.status.textContent = s.columns.length
      ? `${s.row_count.toLocaleString()} rows${s.truncated ? " (truncated)" : ""} · ${s.elapsed_ms} ms`
      : `${s.affected ?? 0} rows affected · ${s.elapsed_ms} ms`;
    if (/^\s*(create|drop|alter)\b/i.test(sqlText)) refreshObjects();
  } catch (e) {
    await t.grid.setResult(null);
    t.status.textContent = t.cancelled ? "Query cancelled" : "Error: " + e;
    t.status.classList.toggle("text-danger", !t.cancelled);
    t.running = false; t.runBar?.remove();
    return;
  }
  t.running = false; t.runBar?.remove();
  t.status.classList.remove("text-danger");
}

const orig = (g: Grid, r: number, i: number): Val => g.original(r)?.[i] ?? { t: "Null" };

function buildChanges(t: Tab): Change[] | string {
  const g = t.grid, cols = t.cols!;
  const pk = cols.map((c, i) => [c, i] as const).filter(([c]) => c.primary_key);
  const colIdx = (name: string) => g.columns.findIndex((c) => c.name === name);
  const numeric = (type: string) => /int|serial|numeric|decimal|real|float|double|number/i.test(type);
  const typed = (name: string, v: Val): Val => {
    const c = cols.find((x) => x.name === name);
    if (v.t === "Text" && c && numeric(c.type_name) && v.v.trim() !== "" && !isNaN(Number(v.v))) {
      return /^-?\d+$/.test(v.v.trim()) ? { t: "I64", v: Number(v.v) } : { t: "F64", v: Number(v.v) };
    }
    return v;
  };
  const key = (r: number): [string, Val][] => pk.map(([c]) => [c.name, orig(g, r, colIdx(c.name))] as [string, Val]);
  const out: Change[] = [];
  for (const [r, m] of g.edits) {
    if (g.deleted.has(r)) continue;
    if (!g.original(r)) return "Edited rows must be loaded; scroll to them and try again.";
    out.push({ kind: "update", key: key(r), set: [...m].map(([i, v]) => [g.columns[i].name, typed(g.columns[i].name, v)] as [string, Val]) });
  }
  for (const r of g.deleted) {
    if (!g.original(r)) return "Deleted rows must be loaded; scroll to them and try again.";
    out.push({ kind: "delete", key: key(r) });
  }
  const n = g.columns.length;
  g.inserted.forEach((row) => out.push({ kind: "insert", set: row.map((v, i) => [g.columns[i].name, typed(g.columns[i].name, v)] as [string, Val]).filter(([, v]) => v.t !== "Null") }));
  void n;
  return out;
}

/** Show the generated SQL and, on confirmation, run it in one transaction. */
async function commitChanges(t: Tab) {
  if (!t.conn || !t.table || !t.cols) return;
  const changes = buildChanges(t);
  if (typeof changes === "string") { t.status.textContent = changes; return; }
  try {
    const stmts = await api.applyChanges(t.conn.id, t.schemaName ?? null, t.table, changes, true);
    if (!(await confirmSql(stmts))) return;
    await api.applyChanges(t.conn.id, t.schemaName ?? null, t.table, changes, false);
    t.grid.discard(); // staged changes are now in the database
    reload(t);
  } catch (e) {
    t.status.textContent = "Commit failed: " + e;
    t.status.classList.add("text-danger");
  }
}

function confirmSql(stmts: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const o = document.createElement("div");
    o.className = "fixed inset-0 bg-black/50 flex items-center justify-center z-50";
    o.innerHTML = `<div class="w-[640px] max-h-[70vh] bg-raised rounded-lg border border-line-strong shadow-2xl flex flex-col">
      <div class="px-4 py-2 border-b border-line-strong font-semibold">Review changes (${stmts.length} statement${stmts.length > 1 ? "s" : ""}, one transaction)</div>
      <pre class="mono text-[13px] p-4 overflow-auto flex-1 select-text whitespace-pre-wrap"></pre>
      <div class="p-3 flex justify-end gap-2 border-t border-line-strong">
        <button id="no" class="px-3 py-1 rounded hover:bg-raised2">Cancel</button>
        <button id="yes" class="px-3 py-1 rounded btn-primary">Commit</button></div></div>`;
    o.querySelector("pre")!.textContent = stmts.join("\n");
    const done = (v: boolean) => { o.remove(); window.removeEventListener("keydown", key, true); resolve(v); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") done(false); else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) done(true); };
    window.addEventListener("keydown", key, true);
    (o.querySelector("#no") as HTMLElement).onclick = () => done(false);
    (o.querySelector("#yes") as HTMLElement).onclick = () => done(true);
    document.body.append(o);
    (o.querySelector("#yes") as HTMLElement).focus();
  });
}

function setMode(t: Tab, mode: "data" | "structure") {
  if (t.kind !== "table" || !t.gridWrap || !t.conn || !t.table) return;
  t.mode = mode;
  t.bar?.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  });
  const dataOnly = ["+ Row", "− Row", "Commit", "Discard", "Filter"];
  if (mode === "structure" && t.filterBar?.open) t.filterBar.toggle();
  t.bar?.querySelectorAll<HTMLElement>(".hint").forEach((h) => { h.style.display = mode === "data" ? "" : "none"; });
  t.bar?.querySelectorAll<HTMLElement>("button[data-label]").forEach((b) => { if (dataOnly.includes(b.dataset.label ?? "")) b.style.display = mode === "data" ? "" : "none"; });
  if (mode === "data") { t.gridWrap.replaceChildren(t.grid.el); t.grid.onChange(); return; }
  const conn = t.conn, name = t.table;
  const o = conn.objects.find((x) => x.name === name);
  t.schemaName = o?.schema ?? null;
  if (!t.structure) {
    t.structure = createStructureView(
      () => api.describe(conn.id, t.schemaName ?? null, name),
      async (changes) => {
        if (!changes.length) return false;
        const ddl = await api.applyStructure(conn.id, t.schemaName ?? null, name, changes, true);
        if (!(await confirmSql(ddl))) return false;
        await api.applyStructure(conn.id, t.schemaName ?? null, name, changes, false);
        t.cols = undefined; // force the data tab to re-read primary keys
        refreshSchema(conn);
        return true;
      },
      (m) => { t.status.textContent = m; },
    );
  }
  t.gridWrap.replaceChildren(t.structure.el);
  t.structure.reload().catch((e) => { t.status.textContent = "Cannot read structure: " + e; });
}

/** Re-read table/column names for completion and the sidebar after DDL. */
function refreshSchema(c: Conn) {
  refreshDatabase(c);
}

/** Highlight the Filter button while a filter is active. */
function paintFilter(t: Tab) {
  if (!t.filterBtn) return;
  t.filterBtn.className = t.filterWhere ? "btn btn-primary" : "btn btn-ghost";
  t.filterBtn.querySelector("span")!.textContent = t.filterWhere ? "Filtered" : "Filter";
}

/** Load (or reload) a diagram tab. `t.table` is the focus table, if any. */
function loadDiagram(t: Tab) {
  if (!t.conn || !t.gridWrap) return;
  const wrap = t.gridWrap;
  wrap.innerHTML = `<div class="h-full flex items-center justify-center text-muted">Reading the schema…</div>`;
  t.status.textContent = "Reading the schema…";
  api.erSchema(t.conn.id, t.table, 60).then((schema) => {
    if (!schema.tables.length) {
      wrap.innerHTML = `<div class="h-full flex flex-col items-center justify-center text-center gap-1"><div class="font-medium">Nothing to draw yet</div><div class="text-soft">This database has no tables.</div></div>`;
      t.status.textContent = "No tables";
      return;
    }
    const d = createDiagram(schema, (tbl) => openTable(tbl.name));
    wrap.replaceChildren(d.el);
    const base = `${schema.tables.length} table${schema.tables.length === 1 ? "" : "s"} · ${schema.relations.length} relation${schema.relations.length === 1 ? "" : "s"}`;
    t.status.textContent = schema.truncated
      ? `${base}. Showing ${schema.tables.length} of ${schema.total_tables} tables. Open a table's diagram to see everything it connects to.`
      : t.table ? `${base}, centred on ${t.table}. Hover to trace relations, double-click a table to open it.` : `${base}. Hover to trace relations, double-click a table to open it.`;
  }).catch((e) => {
    wrap.innerHTML = `<div class="h-full flex items-center justify-center text-danger px-8 text-center">Couldn't read the schema: ${esc(String(e))}</div>`;
    t.status.textContent = "Diagram failed";
  });
}

/** ⌘⇧D: diagram of the whole database, or just one table and what it connects to. */
function openDiagram(focus?: string) {
  if (!conn) { toast("Connect to a database first.", "info"); return; }
  if (["redis", "mongo"].includes(conn.kind)) { toast("Diagrams need a relational database.", "info"); return; }
  const existing = tabs.find((t) => t.kind === "diagram" && t.conn === conn && t.table === focus);
  if (existing) { activate(existing); loadDiagram(existing); return; }
  const t = makeTab("diagram", focus ? `${focus} · diagram` : "Diagram", focus);
  loadDiagram(t);
}

function currentSql(t: Tab): string {
  const view = t.editor!;
  const sel = view.state.selection.main;
  if (!sel.empty) return view.state.sliceDoc(sel.from, sel.to);
  // Statement under the cursor (split on ;), falling back to the whole editor.
  const doc = view.state.doc.toString();
  const start = doc.lastIndexOf(";", Math.max(0, sel.head - 1)) + 1;
  const end = doc.indexOf(";", sel.head);
  const stmt = doc.slice(start, end < 0 ? doc.length : end).trim();
  return stmt || doc.trim();
}

/** ⌘E: show the query plan with optimizer suggestions; ⌘⇧E also runs the query (EXPLAIN ANALYZE). */
async function explainActive(analyze: boolean) {
  const t = active;
  if (!t || t.kind !== "query" || !t.gridWrap) return;
  const sqlText = currentSql(t);
  if (!sqlText) return;
  const hints = lintSql(sqlText);
  const show = (el: HTMLElement) => {
    t.panel = el;
    t.gridWrap!.replaceChildren(el);
  };
  if (!t.conn) return show(hintsPanel(hints));
  t.status.textContent = analyze ? "Analyzing…" : "Explaining…";
  try {
    const plan = await api.explain(t.conn.id, sqlText, analyze);
    show(renderPlan(plan, [...hints, ...lintPlan(plan)]));
    t.status.textContent = "Query plan — press ⌘Enter to return to results";
  } catch (e) {
    show(hintsPanel(hints));
    t.status.textContent = "Explain failed: " + e;
  }
}

function runActive() {
  const t = active;
  if (!t || t.kind === "diagram") return;
  if (t.kind === "table") return reload(t);
  const view = t.editor!;
  const sel = view.state.selection.main;
  const text = sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to);
  if (text.trim()) exec(t, text);
}

function reload(t: Tab) {
  if (t.kind === "diagram") return loadDiagram(t);
  if (t.kind === "table" && t.table && t.conn) {
    const o = t.conn.objects.find((x) => x.name === t.table);
    t.schemaName = o?.schema ?? null;
    if (t.grid.pendingCount) { t.status.textContent = "Commit (⌘S) or discard pending changes before reloading"; return; }
    api.describe(t.conn.id, t.schemaName, t.table)
      .then((d) => { t.cols = d.columns; t.grid.editable = o?.kind !== "view" && d.columns.some((c) => c.primary_key); })
      .catch(() => { t.grid.editable = false; })
      .then(() => api.selectAllSql(t.conn!.id, t.schemaName ?? null, t.table!, undefined, t.filterWhere))
      .then((q) => exec(t, q))
      .then(() => t.grid.onChange());
  } else runActive();
}

function openTable(name: string, c: Conn | null = conn) {
  if (!c) return;
  conn = c;
  const existing = tabs.find((t) => t.kind === "table" && t.table === name && t.conn === c);
  if (existing) return activate(existing);
  const t = makeTab("table", name, name, c);
  reload(t);
}

async function refreshObjects(c: Conn | null = conn) {
  if (!c) return;
  c.loading = true; renderObjects();
  try { c.objects = await api.listObjects(c.id); } finally { c.loading = false; }
  renderObjects();
}

/** Reload one database's tables and the completion schema (after DDL, imports, restores). */
async function refreshDatabase(c: Conn) {
  await refreshObjects(c);
  api.schemaMap(c.id).then((m) => {
    c.schema = m;
    for (const t of tabs) {
      if (!t.editor || t.conn !== c) continue;
      t.editor.dispatch({ effects: sqlLang.reconfigure(langFor(c)) });
      (t.builder as (HTMLElement & { refresh?: () => void }) | undefined)?.refresh?.();
    }
  }).catch(() => {});
}

// ---------- sidebar tree: servers -> databases -> tables ----------
const collapsed = new Set<string>();
interface RowOpts { level: number; ic: string; label: string; sub?: string; badge?: string; stripe?: string; chevron?: "open" | "shut"; count?: number; active?: boolean; strong?: boolean; muted?: boolean; actions?: { ic: string; title: string; fn: () => void }[]; click?: () => void; dbl?: () => void; menu?: (x: number, y: number) => void; title?: string }
function treeRow(o: RowOpts & { hue?: string; env?: string | null }): HTMLElement {
  const d = document.createElement("div");
  const chev = o.chevron ? `<span class="text-muted shrink-0" style="width:12px;transition:transform .16s var(--ease-out);transform:rotate(${o.chevron === "open" ? 90 : 0}deg)">${icon("chevron", 11)}</span>` : `<span style="width:12px" class="shrink-0"></span>`;
  if (o.level === 0) { // the connection itself: a card in its engine's colour
    d.className = "group srv-card select-none";
    d.style.setProperty("--hue", o.hue ?? "var(--accent)");
    d.dataset.env = o.env ?? "local";
    d.innerHTML = chev + (o.badge ?? "") +
      `<span class="min-w-0 flex-1"><span class="block truncate font-semibold text-[14.5px] leading-tight">${esc(o.label)}</span><span class="block truncate text-[12px] text-muted">${esc(o.sub ?? "")}</span></span>` +
      (o.env && o.env !== "local" ? `<span class="pill shrink-0 group-hover:hidden" style="color:${envColor(o.env)};background:color-mix(in srgb, ${envColor(o.env)} 13%, transparent)">${esc(o.env)}</span>` : "");
  } else {
    const h = o.level === 1 ? 32 : o.level === 2 ? 28 : 30;
    d.className = "group tree-row flex items-center gap-1.5 pr-1.5 select-none";
    d.style.height = h + "px";
    d.style.paddingLeft = 6 + (o.level - 1) * 16 + "px";
    if (o.active) d.setAttribute("aria-current", "true");
    d.innerHTML = chev + `<span class="${o.active ? "" : "text-muted"} shrink-0">${icon(o.ic, 15)}</span>` +
      `<span class="min-w-0 flex-1 truncate ${o.level === 2 ? "text-soft font-medium text-[13px]" : ""} ${o.level === 1 ? "font-medium" : ""} ${o.muted ? "text-muted" : ""}">${esc(o.label)}</span>` +
      (o.count !== undefined ? `<span class="text-muted text-[12px] shrink-0 group-hover:hidden">${o.count}</span>` : "");
  }
  if (o.title) d.title = o.title;
  if (o.actions?.length) {
    const box = document.createElement("span");
    box.className = "hidden group-hover:flex items-center shrink-0 rounded-md bg-panel/70";
    for (const a of o.actions) {
      const b = document.createElement("button");
      b.className = "rounded p-1 text-muted hover:text-ink hover:bg-raised2";
      b.title = a.title; b.setAttribute("aria-label", a.title); b.innerHTML = icon(a.ic, 14);
      b.onclick = (e) => { e.stopPropagation(); a.fn(); };
      b.ondblclick = (e) => e.stopPropagation();
      box.append(b);
    }
    d.append(box);
  }
  if (o.click) d.onclick = o.click;
  if (o.dbl) d.ondblclick = o.dbl;
  d.oncontextmenu = (e) => { if (!o.menu) return; e.preventDefault(); o.menu(e.clientX, e.clientY); };
  return d;
}

/** Original line illustrations (two tones: the accent plus the apricot spark). */
const ART_LATTICE = `<svg viewBox="0 0 150 110" width="150" height="110" fill="none" aria-hidden="true"><g fill="currentColor" opacity=".32">${[0, 1, 2, 3, 4].flatMap((i) => [0, 1, 2, 3].map((j) => `<circle cx="${14 + i * 30}" cy="${14 + j * 27}" r="3.2"/>`)).join("")}</g>
  <g stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="44" y="26" width="62" height="54" rx="7" fill="var(--panel)"/><path d="M44 42h62M64 42v38M85 42v38M44 58h62" opacity=".75"/></g>
  <circle cx="134" cy="14" r="6" fill="var(--spark)"/><path d="M106 33 129 17" stroke="var(--spark)" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const ART_RESULTS = `<svg viewBox="0 0 120 80" width="120" height="80" fill="none" aria-hidden="true"><g fill="var(--accent)" opacity=".14"><rect x="8" y="30" width="104" height="11" rx="5"/><rect x="8" y="48" width="104" height="11" rx="5"/><rect x="8" y="66" width="70" height="11" rx="5"/></g>
  <rect x="14" y="6" width="2.6" height="18" rx="1.3" fill="var(--accent)"><animate attributeName="opacity" values="1;0.15;1" dur="1.2s" repeatCount="indefinite"/></rect><rect x="22" y="12" width="36" height="6" rx="3" fill="var(--spark)" opacity=".85"/></svg>`;

const KIND_GROUPS: [string, string, string][] = [["table", "Tables", "table"], ["view", "Views", "view"], ["collection", "Collections", "collection"], ["key", "Keys", "key"]];

function renderObjects() {
  const host = $("objects");
  if (!activeServer) {
    const some = servers.length > 0;
    host.innerHTML = `<div class="px-4 py-10 text-center"><div class="inline-flex text-muted mb-2">${icon("database", 26)}</div><div class="font-medium">${some ? "Choose a connection" : "No connections open"}</div><div class="text-soft mt-0.5 mb-3">${some ? "Pick one from the strip on the left." : "Connect to a database to browse its tables."}</div><button id="emptyconn" class="btn btn-primary">${icon("plug", 14)}<span>Connect</span></button></div>`;
    ($("emptyconn")).onclick = () => showLauncher();
    return;
  }
  const q = $<HTMLInputElement>("filter").value.trim().toLowerCase();
  const openTab = active?.kind === "table" ? active : null;
  const frag = document.createDocumentFragment();
  let any = false;
  for (const s of activeServer ? [activeServer] : []) {
    const sKey = "s:" + s.id, sOpen = q ? true : !collapsed.has(sKey);
    const children: HTMLElement[] = [];
    for (const c of s.conns) {
      const items = c.objects.filter((o) => !q || o.name.toLowerCase().includes(q));
      if (q && !items.length && !(c.db ?? "").toLowerCase().includes(q)) continue;
      const dKey = "d:" + c.id, dOpen = q ? true : !collapsed.has(dKey);
      const here = conn === c;
      children.push(treeRow({
        level: 1, ic: "database", label: c.db ?? "default", strong: true, active: here && !openTab, chevron: dOpen ? "open" : "shut", count: c.objects.length,
        title: `${c.db ?? "default"} on ${s.name}`,
        click: () => { conn = c; dOpen ? collapsed.add(dKey) : collapsed.delete(dKey); renderObjects(); },
        dbl: () => { if (!tabs.some((t) => t.conn === c)) makeTab("query", "Query", undefined, c); },
        menu: (x, y) => dbMenu(c, x, y),
        actions: [{ ic: "plan", title: "New query", fn: () => { conn = c; makeTab("query", "Query", undefined, c); } }, { ic: "close", title: "Close this database", fn: () => closeDatabase(c) }],
      }));
      if (!dOpen) continue;
      if (c.loading && !c.objects.length) { const l = document.createElement("div"); l.className = "pl-14 h-[26px] leading-[26px] text-muted"; l.textContent = "Reading tables…"; children.push(l); continue; }
      for (const [kind, label, ic] of KIND_GROUPS) {
        const list = items.filter((o) => o.kind === kind);
        if (!list.length) continue;
        const gKey = `g:${c.id}:${kind}`, gOpen = q ? true : !collapsed.has(gKey);
        children.push(treeRow({ level: 2, ic, label, muted: true, chevron: gOpen ? "open" : "shut", count: list.length, click: () => { gOpen ? collapsed.add(gKey) : collapsed.delete(gKey); renderObjects(); } }));
        if (!gOpen) continue;
        for (const o of list.slice(0, 2000)) {
          const on = !!openTab && openTab.conn === c && openTab.table === o.name;
          children.push(treeRow({
            level: 3, ic, label: (o.schema && o.schema !== "public" ? o.schema + "." : "") + o.name, active: on, title: "Double-click to open",
            click: () => { conn = c; renderObjects(); }, dbl: () => openTable(o.name, c), menu: (x, y) => tableMenu(c, o, x, y),
          }));
        }
      }
      if (!items.length && !q) { const l = document.createElement("div"); l.className = "pl-14 h-[26px] leading-[26px] text-muted"; l.textContent = c.loading ? "Reading tables…" : "No tables yet"; children.push(l); }
    }
    const remaining = s.dbs.filter((d) => !s.conns.some((c) => c.db === d)).length;
    if (!q && sOpen && remaining > 0 && s.dbs.length) {
      children.push(treeRow({ level: 1, ic: "plus", label: s.conns.length ? "Open another database…" : "Open a database…", muted: !!s.conns.length, strong: !s.conns.length, click: () => pickAndOpen(s) }));
    }
    if (q && !children.length) continue;
    any = true;
    const first = s.conns[0];
    frag.append(treeRow({
      level: 0, ic: "plug", label: s.name, hue: engineVar(s.kind), env: s.env, sub: [ENGINE_NAMES[s.kind] ?? s.kind, s.conns.length > 1 ? `${s.conns.length} databases` : s.conns[0]?.db].filter(Boolean).join(" · "), strong: true,
      badge: engineBadge(s.kind, 28), chevron: sOpen ? "open" : "shut", title: `${ENGINE_NAMES[s.kind] ?? s.kind}${s.env && s.env !== "local" ? " · " + s.env : ""}`,
      click: () => { if (first) conn = first; sOpen ? collapsed.add(sKey) : collapsed.delete(sKey); renderObjects(); },
      menu: (x, y) => serverMenu(s, x, y),
      actions: [{ ic: "plus", title: s.dbs.length ? "Open a database" : "New query", fn: () => (s.dbs.length ? pickAndOpen(s) : makeTab("query", "Query", undefined, s.conns[0] ?? null)) }, { ic: "close", title: "Disconnect", fn: () => disconnectServer(s) }],
    }));
    for (const el of children) frag.append(el);
  }
  if (!any) { host.innerHTML = `<div class="px-3 py-6 text-muted text-center">${q ? "No matches." : "Nothing to show yet."}</div>`; return; }
  host.replaceChildren(frag);
}

function tableMenu(c: Conn, o: ObjectRef, x: number, y: number) {
  contextMenu(x, y, [
    { label: "Open", action: () => openTable(o.name, c) },
    { label: "Structure", action: () => { openTable(o.name, c); const t = tabs.find((k) => k.kind === "table" && k.table === o.name && k.conn === c); if (t) setTimeout(() => setMode(t, "structure"), 30); } },
    { label: "Diagram", hint: "⌘⇧D", disabled: ["redis", "mongo"].includes(c.kind), action: () => { conn = c; openDiagram(o.name); } },
    { divider: true, label: "" },
    { label: "Export…", action: async () => { conn = c; showExport(c.id, await api.selectAllSql(c.id, o.schema, o.name, 2_000_000_000), o.name, (m) => toast(m, "ok")); } },
    { label: "Copy name", action: () => { navigator.clipboard?.writeText(o.name); toast("Copied " + o.name, "ok"); } },
    { divider: true, label: "" },
    { label: "Refresh", action: () => refreshDatabase(c) },
  ]);
}

function dbMenu(c: Conn, x: number, y: number) {
  const canBackup = BACKUP_KINDS.includes(c.kind);
  contextMenu(x, y, [
    { label: "New query", hint: "⌘T", action: () => { conn = c; makeTab("query", "Query", undefined, c); } },
    { label: "Diagram", hint: "⌘⇧D", disabled: ["redis", "mongo"].includes(c.kind), action: () => { conn = c; openDiagram(); } },
    { divider: true, label: "" },
    { label: "Back up…", hint: "⌘⌥B", disabled: !canBackup, action: () => { conn = c; backupActive(); } },
    { label: "Restore…", hint: "⌘⌥R", disabled: !canBackup, action: () => { conn = c; restoreActive(); } },
    { label: "Import a file…", hint: "⌘⌥I", action: () => { conn = c; importActive(); } },
    { divider: true, label: "" },
    { label: "Refresh", action: () => refreshDatabase(c) },
    { label: "Close this database", danger: true, action: () => closeDatabase(c) },
  ]);
}

function serverMenu(s: Server, x: number, y: number) {
  contextMenu(x, y, [
    { label: "New query", disabled: !s.conns.length, action: () => makeTab("query", "Query", undefined, s.conns[0]) },
    { label: s.conns.length ? "Open another database…" : "Open a database…", disabled: !s.dbs.length, action: () => pickAndOpen(s) },
    { label: "Refresh", action: () => s.conns.forEach(refreshDatabase) },
    { divider: true, label: "" },
    { label: "Disconnect", danger: true, action: () => disconnectServer(s) },
  ]);
}

// ---------- connection lifecycle ----------
function afterWorkspaceChange() {
  renderTabs();
  if (!serverTabs().length) { active = null; showHome(); }
}

/** Register an open database under its server and load its tables. */
async function addDatabase(s: Server, connId: number, db: string | null): Promise<Conn> {
  const c: Conn = { id: connId, name: s.name, kind: s.kind, env: s.env, db, dbs: s.dbs, objects: [], schema: [], server: s, loading: true };
  s.conns.push(c);
  conn = c;
  activeServer = s; launcherOpen = false;
  collapsed.delete("s:" + s.id); collapsed.delete("d:" + c.id);
  renderObjects();
  refreshDatabase(c);
  if (!serverTabs(s).length) makeTab("query", "Query", undefined, c); // first tab of this connection
  else renderTabs();
  return c;
}

/** Connect (or re-focus) a saved connection. */
async function useConnection(id: number, p: Profile) {
  const have = servers.find((sv) => sv.id === p.id);
  if (have) { // already connected: drop the duplicate and go to the existing workspace
    if (id >= 0) api.disconnect(id).catch(() => {});
    switchServer(have);
    if (!have.conns.length) pickAndOpen(have);
    return;
  }
  const dbs = await api.listDatabases(id).catch(() => [] as string[]);
  const s: Server = { id: p.id, name: p.name, kind: p.kind, env: p.environment, profile: p, rootId: id, dbs, conns: [] };
  servers.push(s);
  activeServer = s; launcherOpen = false;
  // With a database in the profile, or an engine that has no database list (SQLite, Redis), open it straight away.
  if (p.database || !dbs.length) await addDatabase(s, id, p.database || (p.kind === "sqlite" ? (p.path ?? "").split("/").pop() || "main" : null));
  else { renderObjects(); await pickAndOpen(s); }
}

/** Choose a database on a server and open it next to the ones already open. */
async function pickAndOpen(s: Server) {
  const free = s.dbs.filter((d) => !s.conns.some((c) => c.db === d));
  if (!free.length) { toast("Every database on this server is already open.", "info"); return; }
  const chosen = await pickDatabase(free, null);
  if (chosen) openDatabaseOn(s, chosen);
}

async function openDatabaseOn(s: Server, db: string) {
  const have = s.conns.find((c) => c.db === db);
  if (have) { conn = have; collapsed.delete("d:" + have.id); renderObjects(); return; }
  try {
    const id = await api.openDatabase(s.rootId, db);
    await addDatabase(s, id, db);
  } catch (e) { toast(`Couldn't open ${db}: ${e}`, "error"); }
}

function closeDatabase(c: Conn) {
  for (const t of [...tabs]) if (t.conn === c) closeTab(t);
  // The server's root connection also keeps its SSH tunnel alive, so it stays until the server is disconnected.
  if (c.id !== c.server.rootId) api.disconnect(c.id).catch(() => {});
  c.server.conns = c.server.conns.filter((x) => x !== c);
  if (conn === c) conn = c.server.conns[0] ?? servers.flatMap((x) => x.conns)[0] ?? null;
  renderObjects();
  afterWorkspaceChange();
}

function disconnectServer(s: Server) {
  for (const c of [...s.conns]) { for (const t of [...tabs]) if (t.conn === c) closeTab(t); if (c.id !== s.rootId) api.disconnect(c.id).catch(() => {}); }
  api.disconnect(s.rootId).catch(() => {});
  const wasActive = activeServer === s;
  servers.splice(servers.indexOf(s), 1);
  toast(`Disconnected from ${s.name}`, "info");
  if (!wasActive) { renderTabs(); return; }
  activeServer = null; conn = null; active = null;
  const next = servers[servers.length - 1];
  if (next) switchServer(next); else { renderTabs(); showLauncher(); }
}

/** ⌘K: open another database on the current server. */
function openDatabasePicker() {
  const s = activeServer;
  if (!s) { toast("Connect to a database first.", "info"); return; }
  if (!s.dbs.length) { toast(`${ENGINE_NAMES[s.kind] ?? s.kind} connections have a single database.`, "info"); return; }
  pickAndOpen(s);
}

function queryBar(tab: Tab): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "h-11 shrink-0 flex items-center gap-1 px-3 bg-canvas text-[13.5px]";
  const b = (html: string, title: string, f: () => void, cls = "btn btn-ghost") => {
    const el = document.createElement("button");
    el.innerHTML = html; el.title = title; el.className = cls; el.onclick = f;
    return el;
  };
  const sep = () => { const x = document.createElement("span"); x.className = "w-px h-4 bg-line-strong mx-1.5"; return x; };
  const pill = document.createElement("span");
  pill.className = "pill ml-auto";
  pill.innerHTML = tab.conn ? `<span style="width:7px;height:7px;border-radius:4px;background:${envColor(tab.conn.env)}"></span>${esc(tab.conn.name)}${tab.conn.db ? `<span class="text-muted"> / ${esc(tab.conn.db)}</span>` : ""}` : "No connection";
  bar.append(
    b(`${icon("play", 13)}<span>Run</span><span class="kbd" style="color:inherit;border-color:rgb(255 255 255 / .4);background:transparent">⌘↵</span>`, "Run the selection, or the whole editor (⌘Enter)", () => { activate(tab); runActive(); }, "btn btn-primary"),
    b(`${icon("stop", 13)}<span>Stop</span>`, "Cancel the running query (⌘.)", () => { activate(tab); cancelActive(); }),
    sep(),
    b(`${icon("plan", 14)}<span>Explain</span>`, "Show the query plan and suggestions (⌘E)", () => { activate(tab); explainActive(false); }),
    b(`${icon("wand", 14)}<span>Format</span>`, "Format SQL (⌘I)", () => tab.editor && formatEditor(tab.editor, tab.conn)),
    b(`${icon("blocks", 14)}<span>Builder</span>`, "Visual query builder (⌘B)", () => { activate(tab); toggleBuilder(); }),
    pill,
  );
  return bar;
}

/** The home view: saved connections, plus a one-click way to bring them over from TablePlus. */
async function showLauncher() {
  active = null;
  launcherOpen = true;
  renderTabs();
  const wrap = document.createElement("div");
  wrap.className = "h-full overflow-auto";
  $("main").replaceChildren(wrap);
  const [profiles, tp] = await Promise.all([api.listConnections().catch(() => [] as Profile[]), api.tableplusScan().catch(() => [])]);
  if (active || $("main").firstChild !== wrap) return; // user moved on while we were loading
  const importable = tp.filter((e) => e.kind && !e.already_imported);
  const dismissed = localStorage.getItem("lattice.tpDismissed") === "1";
  wrap.innerHTML = `<div class="mx-auto px-10 pt-12 pb-10" style="max-width:860px">
    <div class="flex items-center gap-5">
      <div class="flex-1"><div class="flex items-center gap-3.5 mb-3"><img src="/lattice-logo.svg" alt="" width="44" height="44" style="border-radius:11px;box-shadow:0 1px 2px rgb(19 34 48 / .18), 0 6px 16px rgb(11 116 160 / .25)"/><span class="text-[15px] font-semibold text-soft">Lattice</span></div>
        <h1 class="text-[30px] font-semibold leading-[1.15] tracking-[-0.02em]">Where would you like to work?</h1>
        <p class="text-soft text-[15px] mt-1.5">Open a saved connection, or add a new one.</p></div>
      <div class="hidden md:block text-muted shrink-0">${ART_LATTICE}</div>
    </div>
    ${importable.length && !dismissed ? `<div id="tpbanner" class="mt-7 flex items-center gap-4 rounded-xl px-4 py-3.5 bg-accent-soft" style="box-shadow: inset 3px 0 0 var(--accent)">
        <div class="flex-1"><div class="font-semibold">${importable.length} connection${importable.length === 1 ? "" : "s"} found in TablePlus</div>
        <div class="text-soft">Bring them over instead of typing hosts and users again.</div></div>
        <button id="tpno" class="btn btn-ghost">Not now</button><button id="tpgo" class="btn btn-primary">Import from TablePlus</button></div>` : ""}
    <div id="tagfilter" class="mt-7 flex flex-wrap items-center gap-2"></div>
    <div id="rows" class="mt-5"></div>
    <div class="mt-6 flex items-center gap-2">
      <button id="newconn" class="btn">${icon("plus", 15)}<span>New connection</span><span class="kbd">⌘N</span></button>
      ${tp.length && (!importable.length || dismissed) ? `<button id="tpgo2" class="btn btn-ghost">Import from TablePlus</button>` : ""}
    </div></div>`;
  const rows = wrap.querySelector("#rows") as HTMLElement;
  const filterHost = wrap.querySelector("#tagfilter") as HTMLElement;
  if (!profiles.length) {
    filterHost.remove();
    rows.innerHTML = `<div class="card px-6 py-10 text-center"><div class="inline-flex text-muted mb-2">${icon("database", 28)}</div>
      <div class="text-[16px] font-semibold">No saved connections yet</div><div class="text-soft mt-1">Add a connection, or import the ones you already have.</div></div>`;
  }
  const sorted = [...profiles].sort((a, b) => a.name.localeCompare(b.name));
  const tagList = [...new Set(sorted.flatMap((p) => p.tags ?? []))].sort((a, b) => a.localeCompare(b));
  const untagged = sorted.filter((p) => !p.tags?.length);
  if (launcherTag !== "all" && launcherTag !== "__none" && !tagList.includes(launcherTag)) launcherTag = "all";
  if (launcherTag === "__none" && !untagged.length) launcherTag = "all";

  const card = (p: Profile): HTMLElement => {
    const row = document.createElement("div");
    const hue = engineVar(p.kind);
    row.className = "group relative flex items-center gap-3.5 rounded-xl px-4 h-[88px] cursor-default overflow-hidden";
    row.style.cssText = `background:var(--panel);box-shadow:var(--shadow-1), inset 0 0 0 1px color-mix(in srgb, ${hue} 16%, var(--line));transition:box-shadow .15s, transform .15s var(--ease-out)`;
    row.onmouseenter = () => { row.style.boxShadow = `var(--shadow-2), inset 0 0 0 1px color-mix(in srgb, ${hue} 38%, var(--line))`; row.style.transform = "translateY(-1px)"; };
    row.onmouseleave = () => { row.style.boxShadow = `var(--shadow-1), inset 0 0 0 1px color-mix(in srgb, ${hue} 16%, var(--line))`; row.style.transform = ""; };
    const where = p.path ?? [p.user && `${p.user}@`, p.host, p.port && `:${p.port}`, p.database && `/${p.database}`].filter(Boolean).join("");
    const edge = p.environment === "production" ? `<span class="absolute inset-y-0 left-0" style="width:4px;background:repeating-linear-gradient(135deg,var(--env-production) 0 3px,transparent 3px 6px);opacity:.8"></span>` : p.environment === "staging" ? `<span class="absolute inset-y-0 left-0" style="width:3px;background:var(--env-staging)"></span>` : "";
    const live = servers.find((sv) => sv.id === p.id);
    row.innerHTML = `${edge}${engineBadge(p.kind, 42)}
      <div class="min-w-0 flex-1"><div class="font-semibold text-[15px] truncate">${esc(p.name)}</div><div class="mono text-[12.5px] text-muted truncate">${esc(where)}${p.ssh_host ? " · via SSH" : ""}</div>
        ${p.tags?.length ? `<div class="flex gap-1.5 mt-1.5 overflow-hidden">${p.tags.slice(0, 3).map((t) => tagChip(t)).join("")}${p.tags.length > 3 ? `<span class="text-muted text-[12px] leading-5">+${p.tags.length - 3}</span>` : ""}</div>` : ""}</div>
      <div class="relative shrink-0 self-start mt-3.5" style="width:96px;height:30px">
        ${live ? `<span class="pill absolute right-0 top-[5px] group-hover:opacity-0" style="color:var(--ok);background:var(--ok-soft)"><span style="width:6px;height:6px;border-radius:3px;background:var(--ok)"></span>connected</span>` : p.environment && p.environment !== "local" ? `<span class="pill absolute right-0 top-[5px] group-hover:opacity-0" style="color:${envColor(p.environment)};background:color-mix(in srgb, ${envColor(p.environment)} 13%, transparent)">${esc(p.environment)}</span>` : ""}
        <button class="btn btn-primary absolute right-0 top-0 opacity-0 group-hover:opacity-100 focus:opacity-100">${live ? "Open" : "Connect"}</button>
      </div>`;
    const go = async () => {
      const btn = row.querySelector("button")!;
      btn.textContent = live ? "Opening…" : "Connecting…"; btn.setAttribute("disabled", "");
      try { await connectProfile(p); } catch (e) { toast(`Couldn't connect to ${p.name}: ${e}`, "error"); btn.textContent = live ? "Open" : "Connect"; btn.removeAttribute("disabled"); }
    };
    row.ondblclick = go;
    row.querySelector("button")!.addEventListener("click", go);
    row.oncontextmenu = (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, [{ label: live ? "Open" : "Connect", action: go }, { label: "Edit connection or tags…", action: openConnections }]); };
    return row;
  };
  const grid = (list: Profile[]) => {
    const g = document.createElement("div");
    g.className = "grid gap-3";
    g.style.gridTemplateColumns = "repeat(auto-fill,minmax(340px,1fr))";
    g.append(...list.map(card));
    return g;
  };

  const drawCards = () => {
    if (!profiles.length) return;
    rows.replaceChildren();
    const grouped = launcherTag === "all" && tagList.length > 0;
    if (!grouped) {
      const list = launcherTag === "all" ? sorted : launcherTag === "__none" ? untagged : sorted.filter((p) => p.tags?.some((t) => t === launcherTag));
      rows.append(grid(list));
      return;
    }
    // Grouped view: each connection sits under its first tag; the chips on the card show all of them.
    const sections: [string | null, Profile[]][] = [...tagList.map((t): [string, Profile[]] => [t, sorted.filter((p) => p.tags?.[0] === t)]), [null, untagged]];
    for (const [tag, list] of sections) {
      if (!list.length) continue;
      const head = document.createElement("div");
      head.className = "flex items-center gap-3 mt-7 mb-3 first:mt-0";
      head.innerHTML = tag ? `${tagChip(tag)}<span class="text-muted text-[13px]">${list.length} connection${list.length === 1 ? "" : "s"}</span>` : `<span class="text-soft text-[13px] font-medium">Untagged</span><span class="text-muted text-[13px]">${list.length}</span>`;
      rows.append(head, grid(list));
    }
  };
  const drawFilter = () => {
    if (!profiles.length || !tagList.length) { filterHost.replaceChildren(); return; }
    const chip = (key: string, label: string, n: number, inner?: string) => {
      const on = launcherTag === key;
      const b = document.createElement("button");
      b.className = "inline-flex items-center gap-2 rounded-full px-3 h-8 text-[13.5px] font-medium " + (on ? "bg-accent-soft text-ink" : "text-soft hover:bg-raised");
      b.style.boxShadow = on ? "inset 0 0 0 1.5px var(--accent)" : "inset 0 0 0 1px var(--line-strong)";
      b.innerHTML = `${inner ?? ""}<span>${esc(label)}</span><span class="text-muted text-[12px]">${n}</span>`;
      b.onclick = () => { launcherTag = key; drawFilter(); drawCards(); };
      return b;
    };
    filterHost.replaceChildren(
      chip("all", "All", sorted.length),
      ...tagList.map((t) => chip(t, t, sorted.filter((p) => p.tags?.includes(t)).length, `<span style="width:8px;height:8px;border-radius:4px;background:${tagHueOf(t)}"></span>`)),
      ...(untagged.length ? [chip("__none", "Untagged", untagged.length)] : []),
    );
  };
  drawFilter();
  drawCards();
  const doImport = async () => { if (await showTablePlusImport(tp)) showLauncher(); };
  (wrap.querySelector("#tpgo") as HTMLElement | null)?.addEventListener("click", doImport);
  (wrap.querySelector("#tpno") as HTMLElement | null)?.addEventListener("click", () => { localStorage.setItem("lattice.tpDismissed", "1"); showLauncher(); });
  (wrap.querySelector("#tpgo2") as HTMLElement | null)?.addEventListener("click", doImport);
  (wrap.querySelector("#newconn") as HTMLElement).onclick = openConnections;
}

async function connectProfile(p: Profile) {
  if (servers.some((sv) => sv.id === p.id)) return useConnection(-1, p); // already connected: just go there
  const id = await api.connectSaved(p.id);
  await useConnection(id, p);
}

/** What to show when no tab is open: the launcher if nothing is connected, otherwise a short workspace hint. */
function showHome() {
  if (!servers.length) { showLauncher(); return; }
  active = null; launcherOpen = false;
  renderTabs();
  const sv = activeServer ?? servers[0];
  const c = conn?.server === sv ? conn : sv.conns[0] ?? null;
  const wrap = document.createElement("div");
  wrap.className = "h-full flex items-center justify-center";
  wrap.innerHTML = `<div class="text-center" style="max-width:380px"><div class="inline-flex mb-3">${engineBadge(sv.kind, 48)}</div>
    <div class="text-[16px] font-semibold">${esc(sv.name)}</div>
    <div class="text-soft mt-1 mb-4">${c ? "No tabs open. Double-click a table in the sidebar, or start a query." : "No database is open on this connection yet."}</div>
    <div class="flex justify-center gap-2">${c ? `<button id="hq" class="btn btn-primary">${icon("plan", 14)}<span>New query</span><span class="kbd" style="color:inherit;border-color:rgb(255 255 255 / .4);background:transparent">⌘T</span></button>` : `<button id="hq" class="btn btn-primary">${icon("database", 14)}<span>Open a database</span><span class="kbd" style="color:inherit;border-color:rgb(255 255 255 / .4);background:transparent">⌘K</span></button>`}<button id="hc" class="btn">${icon("plug", 14)}<span>Connect another</span></button></div></div>`;
  $("main").replaceChildren(wrap);
  $("hq").onclick = () => (c ? makeTab("query", "Query", undefined, c) : pickAndOpen(sv));
  $("hc").onclick = () => showLauncher();
}

function openConnections() {
  showConnectionManager(async (id, profile: Profile) => { await useConnection(id, profile); });
}

function palette() {
  const p = $("palette"), inp = $<HTMLInputElement>("pinput"), list = $("plist");
  p.classList.remove("hidden"); inp.value = ""; inp.focus();
  let idx = 0, items: ObjectRef[] = [];
  const draw = () => {
    const q = inp.value.toLowerCase();
    items = (conn?.objects ?? []).filter((o) => o.name.toLowerCase().includes(q)).slice(0, 50);
    idx = Math.min(idx, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((o, i) => {
      const d = document.createElement("div");
      d.className = "px-4 py-1.5 flex items-center gap-2 " + (i === idx ? "bg-accent text-white" : "");
      d.innerHTML = `${icon(o.kind === "view" ? "view" : o.kind === "key" ? "key" : o.kind === "collection" ? "collection" : "table", 14)}<span>${esc(o.name)}</span><span class="ml-auto text-[12px] opacity-70">${o.kind}</span>`;
      d.onclick = () => choose(o);
      return d;
    }));
  };
  const close = () => { p.classList.add("hidden"); inp.oninput = inp.onkeydown = null; };
  const choose = (o: ObjectRef) => { close(); openTable(o.name); };
  inp.oninput = draw;
  inp.onkeydown = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") { idx = Math.min(idx + 1, items.length - 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { idx = Math.max(idx - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === "Enter" && items[idx]) choose(items[idx]);
  };
  draw();
}

/** ⌘⌥E: export the active tab's full result (not just the rows on screen) to a file. */
async function exportActive() {
  const t = active;
  if (!t?.conn) return;
  let sqlText: string;
  if (t.kind === "table" && t.table) {
    const o = t.conn.objects.find((x) => x.name === t.table);
    sqlText = await api.selectAllSql(t.conn.id, o?.schema ?? null, t.table, 2_000_000_000, t.filterWhere);
  } else if (t.kind === "query") sqlText = currentSql(t);
  else return;
  if (!sqlText.trim()) return;
  showExport(t.conn.id, sqlText, t.table ?? "export", (m) => { t.status.textContent = m; });
}

/** ⌘⌥I: import CSV / TSV / JSON into a table. */
async function importActive() {
  const c = active?.conn ?? conn;
  if (!c) return;
  const t = active;
  await showImport(c.id, c.objects, t?.kind === "table" ? t.table : undefined,
    async (o) => (await api.describe(c.id, o.schema, o.name)).columns.map((x) => x.name),
    async (msg) => {
      if (t) t.status.textContent = msg;
      await refreshDatabase(c);
      // Reload an open table tab that was just imported into.
      for (const x of tabs) if (x.kind === "table" && x.conn === c && !x.grid.pendingCount) reload(x);
    });
}

/** ⌘⌥B: back up the connected database to a SQL file. */
function backupActive() {
  if (!conn) { toast("Connect to a database first.", "info"); return; }
  if (!BACKUP_KINDS.includes(conn.kind)) { toast(`Backup isn't available for ${ENGINE_NAMES[conn.kind] ?? conn.kind} yet.`, "info"); return; }
  const c = conn;
  showBackup(c.id, c.name, c.db ?? c.name, c.objects, (m) => { toast(m, m.startsWith("Backup failed") ? "error" : "ok"); });
}

/** ⌘⌥R: run a SQL backup file against the connected database. */
function restoreActive() {
  if (!conn) { toast("Connect to a database first.", "info"); return; }
  if (!BACKUP_KINDS.includes(conn.kind)) { toast(`Restore isn't available for ${ENGINE_NAMES[conn.kind] ?? conn.kind} yet.`, "info"); return; }
  const c = conn;
  showRestore(c.id, c.name, c.db ?? "", c.env, async (m) => { toast(m, /failed|stopped|error/i.test(m) ? "error" : "ok"); await refreshDatabase(c); });
}

async function cancelActive() {
  const t = active;
  if (!t?.running || !t.conn) return;
  t.cancelled = true;
  t.status.textContent = "Cancelling…";
  try { await api.cancelQuery(t.conn.id); } catch (e) { t.status.textContent = "Cancel failed: " + e; }
}

// Keyboard shortcuts (TablePlus-style)
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && active?.running) { e.preventDefault(); cancelActive(); return; }
  if (!e.metaKey) return;
  const k = e.key.toLowerCase();
  const go = (f: () => void) => { e.preventDefault(); f(); };
  // ⌥ changes e.key on macOS, so match the physical key for the ⌘⌥ combos.
  if (e.altKey && e.code === "KeyE") return go(exportActive);
  if (e.altKey && e.code === "KeyI") return go(importActive);
  if (e.altKey && e.code === "KeyB") return go(backupActive);
  if (e.altKey && e.code === "KeyR") return go(restoreActive);
  if (k === "t") go(newQuery);
  else if (k === "w") go(() => active && closeTab(active));
  else if (k === "o" || k === "n") go(openConnections);
  else if (k === "p") go(palette);
  else if (k === "d" && e.shiftKey) go(() => openDiagram(active?.kind === "table" ? active.table : undefined));
  else if (k === "k") go(openDatabasePicker);
  else if (k === "r") go(() => active && reload(active));
  else if (k === "enter") go(runActive);
  else if (k === "e") go(() => explainActive(e.shiftKey));
  else if (k === "b") go(toggleBuilder);
  else if (e.key === ".") go(cancelActive);
  else if (k === "s" && active?.kind === "table") go(() => commitChanges(active!));
  else if (k === "i" && active?.kind === "table") go(() => active!.grid.addRow());
  else if (e.key === "Backspace" && active?.kind === "table" && !(e.target instanceof HTMLInputElement)) go(() => active!.grid.deleteSelected());
  else if (/^[1-9]$/.test(k)) go(() => { const t = nthTab(tabs, activeServer, +k); if (t) activate(t); });
  else if (e.shiftKey && (e.key === "]" || e.key === "}")) go(() => cycle(1));
  else if (e.shiftKey && (e.key === "[" || e.key === "{")) go(() => cycle(-1));
  else if (k === "f" && active?.kind === "table" && active.filterBar) go(() => { if (active!.mode === "structure") setMode(active!, "data"); active!.filterBar!.toggle(); });
  else if (k === "l" && e.shiftKey) go(toggleTheme);
  else if (k === "l") go(() => $("filter").focus());
});

/** New query tab in the current database of the current connection. */
function newQuery() {
  const c = conn?.server === activeServer ? conn : activeServer?.conns[0] ?? null;
  if (!c) { toast(activeServer?.dbs.length ? "Open a database first (⌘K)." : "Connect to a database first.", "info"); return; }
  makeTab("query", "Query", undefined, c);
}

function cycle(d: number) {
  if (!active) return;
  const next = cycleTab(tabs, active, d);
  if (next) activate(next);
}

$("backup").onclick = backupActive;
$("restore").onclick = restoreActive;
$("import").onclick = importActive;
$("export").onclick = exportActive;
$("newtab").onclick = newQuery;
$("open").onclick = openConnections;
$("addconn").onclick = () => showLauncher();
$("diagram").onclick = () => openDiagram();
const paintTheme = () => { $("theme").innerHTML = icon(currentTheme() === "dark" ? "sun" : "moon", 15); };
const toggleTheme = () => { applyTheme(currentTheme() === "dark" ? "light" : "dark"); paintTheme(); };
$("theme").onclick = toggleTheme;
paintTheme();
renderObjects();
showLauncher();
$("filter").oninput = renderObjects;
