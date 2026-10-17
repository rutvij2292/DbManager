import "./style.css";
import { installMock } from "./mock";
// Dev only: `?mock` renders the UI without the Rust backend. Stripped from production builds.
if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) installMock();
import { open } from "@tauri-apps/plugin-dialog";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { search, searchKeymap } from "@codemirror/search";
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
import { buildOrder, nextSort, setSort, detectSort, countSql, wrapForSort, type SortKey, type FilterRule } from "./builder-sql";
import { api, show, type ObjectRef, type Summary, type Profile, type SchemaTable, type ColumnInfo, type Change, type Val } from "./api";
import { showConnectionManager } from "./connections";
import { icon, engineBadge, engineVar, envColor, isCareful, ENGINE_NAMES } from "./icons";
import { applyAppearance, capturing, comboOf, matchAction, prettyCombo, showSettings } from "./settings";
import { applyTheme, currentTheme, esc, toast, contextMenu, tagChip, tagHue as tagHueOf } from "./ui";
import { showTablePlusImport } from "./tpimport";
import { tabsOf, nextAfterClose, nthTab, cycleTab, tabForSwitch } from "./workspace";
import { pickDatabase } from "./dbpicker";
import { createDiagram } from "./diagram";
import { showBackup, showRestore, BACKUP_KINDS } from "./backup";
import { Grid } from "./grid";
import { formatRows, type CopyFormat } from "./copyfmt";
import { splitStatements, statementAt } from "./sqlsplit";
import { analyzeSelect, resolveEdit } from "./resultedit";
import { pushHistory, loadSaved, findFavorite, addFavorite, renameQuery, deleteQuery, loadDrafts, saveDraft, removeDraft, dropLegacyHistory, type HistoryItem } from "./qstore";
import { clickSelect, type Selection } from "./selection";
import { SYSTEM_DBS, canManageDatabases, canTruncateAll, canIgnoreForeignKeys, ignoreFkLabel, destructiveKind, isReadOnlySql, safetyLevel, isForeignKeyError, createDatabaseSql, dropDatabaseSql, truncateAllSql, truncateTableSql, dropTableSql, truncateTablesSql, dropTablesSql, promptName, confirmDanger } from "./dbadmin";
import { sessionKey, loadSessions, addSession, removeSessions, ago, type Session } from "./qhistory";

/**
 * The webview offers its own "recent entries" dropdown on text inputs (palette, search, connection form).
 * Switch that off everywhere; only the SQL editor and query builder have real autocompletion.
 */
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || el.closest(".cm-editor, [data-autocomplete]")) return;
  el.setAttribute("autocomplete", "off");
  el.setAttribute("autocorrect", "off");
  el.setAttribute("autocapitalize", "off");
  el.spellcheck = false;
});

/** One open database: its own backend connection, tables and completion schema. */
interface Conn { id: number; name: string; kind: string; env?: string | null; sub?: string; db?: string | null; dbs?: string[]; objects: ObjectRef[]; schema: SchemaTable[]; server: Server; loading?: boolean; lastTab?: Tab | null; routines?: ObjectRef[]; history?: HistoryItem[]; log?: { at: number; ms: number; sql: string; err?: string; tab?: number }[] }
/** A saved connection that is currently connected, with the databases opened on it. */
interface Server { id: string; name: string; kind: string; env?: string | null; profile: Profile; rootId: number; dbs: string[]; conns: Conn[] }
/** One statement's outcome from ⌘⇧Enter (run all): a row set (kept in Rust until the next run), a row count, or an error. */
interface StmtResult { sql: string; summary: Summary | null; affected?: number; ms?: number; error?: string }
interface Tab {
  id: number; title: string; kind: "query" | "table" | "diagram";
  conn: Conn | null; table?: string;
  root: HTMLElement; grid: Grid; panel?: HTMLElement; gridWrap?: HTMLElement; cols?: ColumnInfo[]; schemaName?: string | null; bar?: HTMLElement; builder?: HTMLElement; edWrap?: HTMLElement; sort: SortKey[]; baseSql?: string; running?: boolean; cancelled?: boolean; empty?: HTMLElement; runBar?: HTMLElement; structure?: ReturnType<typeof createStructureView>; mode?: "data" | "structure"; filterBar?: ReturnType<typeof createFilterBar>; filterWhere?: string; filterBtn?: HTMLElement; editor?: EditorView; status: HTMLElement; shown?: Session[]; draftId: string; draftTimer?: number; results?: StmtResult[]; resultIdx?: number; resultBar?: HTMLElement; lastMs?: number; failed?: boolean; countBtn?: HTMLButtonElement; countSeq?: number;
  /** A query result that maps to one table and can be edited in place (see resultedit.ts), and the bar that shows it. */
  edit?: EditTarget; editBar?: HTMLElement; editSeq?: number;
}
interface EditTarget { table: string; schema: string | null; cols: ColumnInfo[]; map: (string | null)[] }

/** The current workspace: the database the sidebar last selected or the active tab belongs to. */
let conn: Conn | null = null;
const servers: Server[] = [];
/** The connection whose workspace is on screen. Tabs, sidebar and shortcuts only ever see this one. */
let activeServer: Server | null = null;
let launcherOpen = false;
/** Home-screen tag filter: "all", a tag name, or "__none" for connections without tags. */
let launcherTag = "all";
/** Tabs that belong to a connection. This is the only list the UI may iterate: connections never share tabs. */
const wsTabs = (c: Conn | null = conn): Tab[] => tabsOf(tabs, c);
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
applyAppearance();
const iconBtn = (id: string, ic: string, title: string) => `<button id="${id}" class="btn btn-ghost" style="width:28px;padding:0;justify-content:center" title="${title}" aria-label="${title}">${icon(ic, 16)}</button>`;
app.innerHTML = `
  <div class="h-full flex gap-2 p-2">
    <nav id="rail" class="w-[78px] shrink-0 glass rounded-2xl flex flex-col items-center" aria-label="Connections">
      <div class="titlebar h-11 shrink-0 w-full"></div>
      <div id="rail-items" class="flex-1 overflow-y-auto overflow-x-visible flex flex-col items-center gap-1 py-1 w-full px-1.5"></div>
      <div class="flex flex-col items-center gap-1 py-2.5">
        <button id="addconn" class="flex flex-col items-center justify-center gap-0.5 rounded-xl" style="width:66px;height:50px" title="Connect to another database (⌘N)" aria-label="Connect to another database">${icon("plus", 18)}<span class="text-[11.5px]">Connect</span></button>
        <button id="settings" class="btn btn-ghost" style="width:34px;height:30px;padding:0;justify-content:center" title="Settings (⌘,)" aria-label="Settings">${icon("gear", 15)}</button>
        <button id="theme" class="btn btn-ghost" style="width:34px;height:30px;padding:0;justify-content:center" title="Switch theme (⌘⇧L)" aria-label="Switch theme"></button>
      </div>
    </nav>
    <aside id="sidebar" class="relative shrink-0 glass rounded-2xl flex flex-col min-h-0" style="width:272px">
      <div id="sb-grip" class="grip-col" title="Drag to resize the sidebar"></div>
      <div class="titlebar h-11 shrink-0"></div>
      <div class="px-3 mb-2"><div id="sidetabs" class="seg w-full" style="display:flex"></div></div>
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
          ${iconBtn("more", "more", "Back up, restore, import…")}<span class="w-px h-4 bg-line-strong mx-1"></span>
          ${iconBtn("export", "download", "Export the result… (⌘⌥E)")}${iconBtn("sqllog-btn", "plan", "SQL log: the statements that ran (⌘J)")}${iconBtn("newtab", "plus", "New query tab (⌘T)")}
        </div>
      </div>
      <main id="main" class="card flex-1 min-h-0 flex flex-col" style="border-top-left-radius:0"></main>
      <div id="sqllog" class="hidden card shrink-0 mt-1.5 flex flex-col" style="height:132px"></div>
    </div>
  </div>
  <div id="palette" class="hidden fixed inset-0 flex items-start justify-center pt-24 z-50" style="background:color-mix(in srgb, var(--ink) 26%, transparent);backdrop-filter:blur(8px)">
    <div class="w-[580px] glass-strong rounded-2xl overflow-hidden">
      <input id="pinput" placeholder="Open a table, view or collection" class="w-full bg-transparent px-5 py-3.5 outline-none border-b border-line text-[16px]"/>
      <div id="plist" class="max-h-80 overflow-auto py-1.5"></div>
    </div>
  </div>`;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Sidebar: drag the grip on its right edge; the width is remembered.
{
  const sb = $("sidebar"), grip = $("sb-grip");
  const clamp = (w: number) => Math.round(Math.min(520, Math.max(212, w)));
  sb.style.width = clamp(+(localStorage.getItem("tabnix.sidebarW") ?? 272)) + "px";
  grip.onpointerdown = (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("drag");
    const left = sb.getBoundingClientRect().left;
    grip.onpointermove = (ev) => { const w = clamp(ev.clientX - left); sb.style.width = w + "px"; localStorage.setItem("tabnix.sidebarW", String(w)); };
    grip.onpointerup = () => { grip.classList.remove("drag"); grip.onpointermove = grip.onpointerup = null; };
  };
  grip.ondblclick = () => { sb.style.width = "272px"; localStorage.setItem("tabnix.sidebarW", "272"); };
}

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
    statusBar.innerHTML = `<span class="pill shrink-0" style="--hue:${engineVar(c.kind)};background:color-mix(in srgb, ${engineVar(c.kind)} 12%, transparent);color:var(--ink)"><span style="width:7px;height:7px;border-radius:4px;background:${engineVar(c.kind)}"></span>${esc(c.name)}${c.db ? `<span class="text-muted"> / ${esc(c.db)}</span>` : ""}</span>${risky ? `<span class="pill shrink-0" style="color:${envColor(c.env)};background:color-mix(in srgb, ${envColor(c.env)} 12%, transparent)">${esc(c.env!)}</span>` : ""}${safetyLevel(c.server.profile) === "readonly" ? `<span class="pill shrink-0" title="Nothing can be changed on this connection">read-only</span>` : ""}`;
  }
  statusBar.append(status);
  const countBtn = document.createElement("button");
  countBtn.className = "btn btn-ghost shrink-0";
  countBtn.style.cssText = "height:24px;display:none";
  statusBar.append(countBtn);
  const selInfo = document.createElement("span");
  selInfo.className = "shrink-0 text-muted";
  statusBar.append(selInfo);
  const tab: Tab = { draftId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, id: ++tabSeq, title, kind, conn: c, table, root, grid, status, sort: [], countBtn };
  grid.sortable = kind !== "diagram" && !["redis", "mongo"].includes(c?.kind ?? "");
  grid.onSort = (col, additive, x, y) => {
    if (additive) { applySort(tab, nextSort(tab.sort, col, true)); return; }
    const cur = tab.sort.length === 1 && tab.sort[0].col === col ? tab.sort[0] : null;
    contextMenu(x, y, [
      { label: "Sort ascending", hint: cur && !cur.desc ? "✓" : "", action: () => applySort(tab, setSort(col, "asc")) },
      { label: "Sort descending", hint: cur?.desc ? "✓" : "", action: () => applySort(tab, setSort(col, "desc")) },
      { divider: true, label: "" },
      { label: "Clear sort", disabled: !tab.sort.length, action: () => applySort(tab, setSort(col, "clear")) },
    ]);
  };
  grid.onCellMenu = (x, y, r, col) => cellMenu(tab, x, y, r, col);
  grid.onSelect = () => { const n = grid.selectedCount; selInfo.textContent = n > 1 ? `${n.toLocaleString()} rows selected` : ""; };
  if (kind === "query") {
    root.append(queryBar(tab));
    const ed = document.createElement("div");
    ed.className = "overflow-hidden shrink-0";
    ed.style.height = editorHeight();
    tab.editor = new EditorView({
      parent: ed,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(), history(), search({ top: true }), syntaxHighlighting(sqlHighlight), sqlLang.of(langFor(c)),
          autocompletion({ override: [makeCompletionSource(() => tab.conn?.schema ?? [])], activateOnTyping: true, icons: false }),
          EditorView.updateListener.of((u) => { if (u.docChanged) scheduleDraft(tab); for (const tr of u.transactions) { const c = tr.annotation(pickedCompletion); if (c) recordAccepted(c.label); } }),
          keymap.of([
            // ⌘↵ / ⌘⇧↵ are run by the global (rebindable) shortcut handler. These entries only stop CodeMirror's own
            // Mod-Enter (insertBlankLine) from also inserting a newline.
            { key: "Mod-Enter", run: () => true },
            { key: "Mod-Shift-Enter", run: () => true },
            { key: "Mod-i", run: (v) => (formatEditor(v, tab.conn), true) },
            ...searchKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap,
          ]),
        ],
      }),
    });
    tab.edWrap = ed;
    root.append(ed);
    // drag to give the editor or the results more room; the choice is remembered
    const split = document.createElement("div");
    split.className = "split-row";
    split.title = "Drag to resize";
    split.onpointerdown = (e) => {
      e.preventDefault();
      split.setPointerCapture(e.pointerId);
      split.classList.add("drag");
      split.onpointermove = (ev) => {
        const total = root.getBoundingClientRect().height || 1;
        const frac = Math.min(0.78, Math.max(0.12, (ev.clientY - ed.getBoundingClientRect().top) / total));
        localStorage.setItem("tabnix.editorFrac", String(frac));
        if (!tab.builder) ed.style.height = frac * 100 + "%";
      };
      split.onpointerup = () => { split.classList.remove("drag"); split.onpointermove = split.onpointerup = null; };
    };
    root.append(split);
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
    const recent = c?.server ? loadSessions(sessionKey(c.server.id, c.db)).slice(0, 5) : [];
    if (recent.length) {
      tab.shown = recent;
      const box = document.createElement("div");
      box.className = "pointer-events-auto text-left mt-5 w-[min(560px,90%)]";
      box.dataset.recent = "";
      box.innerHTML = `<div class="text-[12px] uppercase tracking-wide text-muted mb-1.5 px-1">Recent queries on ${esc(c!.db ?? c!.name)}</div>`;
      for (const r of recent) {
        const row = document.createElement("button");
        row.className = "w-full flex items-center gap-3 px-3 h-9 rounded-lg hover:bg-raised text-left";
        row.title = r.sql;
        row.innerHTML = `<span class="mono text-[13px] truncate flex-1 min-w-0"></span><span class="text-[12px] text-muted shrink-0">${ago(r.at)}</span>`;
        (row.firstElementChild as HTMLElement).textContent = r.sql.replace(/\s+/g, " ");
        row.onclick = () => { tab.editor?.dispatch({ changes: { from: 0, to: tab.editor.state.doc.length, insert: r.sql }, selection: { anchor: r.sql.length } }); tab.editor?.focus(); };
        box.append(row);
      }
      empty.append(box);
    }
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
    const discard = btn("Discard", "Discard pending changes (⌘⌥Z)", () => discardChanges(tab), "undo");
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
    const delRow = btn("Row", "Delete selected row (⌘⌫)", () => deleteRow(tab), "minus", "btn btn-ghost");
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
    grid.onChange = () => { refreshBar(); syncDirtyRows(); };
    grid.onDeleteKey = () => { if (grid.editable && grid.rowOps) deleteRow(tab); };
    refreshBar();
    setTimeout(() => setMode(tab, "data"), 0);
    tab.bar = bar;
    root.append(bar);
    if (tab.filterBar) root.append(tab.filterBar.el);
  }
  if (kind === "query") {
    tab.resultBar = document.createElement("div");
    tab.resultBar.className = "hidden shrink-0 px-3 py-1.5 bg-canvas overflow-x-auto";
    root.append(tab.resultBar);
    tab.editBar = document.createElement("div");
    tab.editBar.className = "hidden shrink-0 h-9 flex items-center gap-1.5 px-3 bg-canvas text-[13.5px]";
    root.append(tab.editBar);
    grid.onChange = () => paintEditBar(tab);
  }
  root.append(gridWrap, statusBar);
  tabs.push(tab);
  activate(tab); // also switches the workspace to this tab's connection
  tab.editor?.focus();
  return tab;
}

/** The editor's share of a query tab (remembered between sessions). */
const editorHeight = () => Math.round(Math.min(0.78, Math.max(0.12, +(localStorage.getItem("tabnix.editorFrac") ?? 0.34))) * 100) + "%";

const quoteFor = (c: Conn | null) => (c?.kind === "mssql" ? (s: string) => "[" + s.replace(/]/g, "]]") + "]" : c && ["mysql", "mariadb"].includes(c.kind) ? (s: string) => "`" + s.replace(/`/g, "``") + "`" : (s: string) => '"' + s.replace(/"/g, '""') + '"');

/** ⌘B: toggle the visual query builder above the editor. */
function toggleBuilder() {
  const t = active;
  if (!t || t.kind !== "query" || !t.editor || !t.edWrap) return;
  if (t.builder) {
    t.builder.remove();
    t.builder = undefined;
    t.edWrap.style.height = editorHeight();
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
  t.edWrap.style.height = "26%";
}

function activate(t: Tab) {
  if (active && active !== t) active.grid.suspend(); // background tabs hold no row data in the webview
  active = t;
  launcherOpen = false;
  if (t.conn) {
    conn = t.conn; // the sidebar and dialogs follow the tab you are working in
    activeServer = t.conn.server;
    t.conn.lastTab = t;
  }
  $("main").replaceChildren(t.root);
  t.grid.resume();
  renderTabs();
  renderLog();
}

/** Switch the whole workspace (tabs, sidebar) to another open database. */
function switchWorkspace(c: Conn) {
  conn = c; activeServer = c.server;
  launcherOpen = false;
  const target = tabForSwitch(tabs, c, c.lastTab);
  if (target) { activate(target); return; }
  active = null;
  renderTabs();
  showHome();
}

/** Rail entry of a server with no database open yet, or any server: go to its current (else newest) database. */
function switchServer(s: Server) {
  if (s.conns.length) { switchWorkspace(s.conns.includes(conn!) ? conn! : s.conns[s.conns.length - 1]); return; }
  activeServer = s; conn = null; active = null; launcherOpen = false;
  renderTabs();
  showHome();
}

/** Keep a query tab's text for the next new tab of this database. `closing` also drops the sessions this tab was showing. */
function rememberSession(t: Tab, closing: boolean) {
  if (t.kind !== "query" || !t.conn?.server || !t.editor) return;
  const key = sessionKey(t.conn.server.id, t.conn.db);
  if (closing && t.shown) { removeSessions(key, t.shown); t.shown = undefined; }
  addSession(key, t.editor.state.doc.toString());
}

/** `keepDraft`: the whole database is being closed, not just this tab, so its text is kept to reopen with the database. */
function closeTab(t: Tab, keepDraft = false) {
  const g = tabs.indexOf(t);
  if (g < 0) return;
  const next = nextAfterClose(tabs, t); // always a tab of the same connection, or null
  tabs.splice(g, 1);
  t.grid.setResult(null);
  syncDirtyRows();
  if (keepDraft) flushDraft(t);
  else { rememberSession(t, true); clearTimeout(t.draftTimer); if (t.conn && t.kind === "query") removeDraft(draftKey(t.conn), t.draftId); }
  releaseResults(t);
  t.editor?.destroy();
  if (t.conn && t.conn.lastTab === t) t.conn.lastTab = null;
  if (active === t) {
    if (next) activate(next);
    else { active = null; renderTabs(); showHome(); }
  } else renderTabs();
}

function renderTabs() {
  const el = $("tabs");
  const mine = wsTabs();
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
      d.innerHTML = `<span style="color:${tint}">${icon(t.kind === "table" ? "table" : t.kind === "diagram" ? "diagram" : "plan", 15)}</span><span class="truncate">${esc(t.title)}</span>` ;
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
  renderLog();
}

// ---------- connection rail: the narrow strip at the far left that switches between connections ----------
/** Database name, numbered when the same database is open more than once on a connection. */
function dbLabel(c: Conn): string {
  const same = c.server.conns.filter((x) => x.db === c.db);
  return `${c.db ?? c.server.name}${same.length > 1 ? ` #${same.indexOf(c) + 1}` : ""}`;
}

function renderRail() {
  const host = $("rail-items");
  // One entry per open database; a server with none open yet gets a single entry of its own.
  const entries = servers.flatMap((s) => (s.conns.length ? s.conns.map((c) => ({ s, c })) : [{ s, c: null as Conn | null }]));
  host.replaceChildren(...entries.map(({ s, c }) => {
    const on = !launcherOpen && (c ? c === conn : s === activeServer);
    const n = c ? wsTabs(c).length : 0;
    const label = c ? dbLabel(c) : s.name;
    const b = document.createElement("button");
    b.className = "relative flex flex-col items-center gap-1 rounded-xl shrink-0 px-1 pt-2 pb-1.5 " + (on ? "glass-strong" : "hover:bg-raised");
    b.style.cssText = "width:66px;transition:background .12s";
    b.setAttribute("aria-label", `${label} on ${s.name}${on ? " (current)" : ""}`);
    b.title = `${s.name}${c?.db ? ` / ${label}` : ""} · ${ENGINE_NAMES[s.kind] ?? s.kind}${s.env && s.env !== "local" ? " · " + s.env : ""}\n${c ? `${n} tab${n === 1 ? "" : "s"}` : "no database open"}`;
    b.innerHTML = engineBadge(s.kind, 36) +
      `<span class="text-[10.5px] leading-[1.15] text-center w-full truncate text-muted">${esc(s.name)}</span>` +
      (c?.db ? `<span class="text-[11.5px] leading-[1.15] text-center w-full truncate -mt-0.5 ${on ? "text-ink font-medium" : "text-soft"}">${esc(label)}</span>` : "") +
      (on ? `<span class="absolute" style="left:-7px;top:18px;width:4px;height:24px;border-radius:0 3px 3px 0;background:var(--hue-active,var(--accent))"></span>` : "") +
      (s.env && s.env !== "local" ? `<span class="absolute" style="right:7px;top:5px;width:10px;height:10px;border-radius:5px;background:${envColor(s.env)};border:2px solid var(--panel)"></span>` : "") +
      (n > 1 ? `<span class="absolute text-[10.5px] font-semibold rounded-full bg-raised2 text-soft" style="right:4px;top:30px;min-width:16px;height:16px;line-height:16px;text-align:center;padding:0 4px">${n}</span>` : "");
    b.onclick = () => (c ? switchWorkspace(c) : switchServer(s));
    b.oncontextmenu = (e) => { e.preventDefault(); c ? dbMenu(c, e.clientX, e.clientY) : serverMenu(s, e.clientX, e.clientY); };
    return b;
  }));
  const plus = $("addconn");
  plus.className = "relative flex flex-col items-center justify-center gap-0.5 rounded-xl " + (launcherOpen ? "glass-strong text-accent" : "text-muted hover:bg-raised hover:text-ink");
}

// ---------- SQL log: every statement that ran on the open database, newest at the bottom (⌘J) ----------
let logOpen = localStorage.getItem("tabnix.logOpen") !== "0"; // open unless the user closed it
/** "tab": only what the active tab ran; "db": everything on this database. */
let logScope: "tab" | "db" = localStorage.getItem("tabnix.logScope") === "db" ? "db" : "tab";
const LOG_MAX = 100, LOG_SQL_MAX = 4000; // in memory only, so it stays tiny

function logSql(c: Conn, sql: string, ms: number, err?: string, tab?: Tab) {
  const log = (c.log ??= []);
  log.push({ at: Date.now(), ms, sql: sql.length > LOG_SQL_MAX ? sql.slice(0, LOG_SQL_MAX) + "…" : sql, err, tab: tab?.id });
  if (log.length > LOG_MAX) log.shift();
  if (logOpen && conn === c) renderLog();
}

const SQL_TOKEN = /('(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|"")*"|`[^`]*`|--[^\n]*|\/\*[\s\S]*?\*\/|\b\d+(?:\.\d+)?\b|\b(?:select|from|where|and|or|not|in|is|null|like|between|join|left|right|inner|outer|full|cross|on|as|group|by|order|having|limit|offset|union|all|distinct|insert|into|values|update|set|delete|create|alter|drop|table|index|view|database|schema|asc|desc|case|when|then|else|end|exists|count|sum|avg|min|max|with|show|describe|explain|use|begin|commit|rollback)\b)/gi;

/** Cheap tokenizer for the log: plain text nodes plus a few coloured spans, no editor instance. */
function highlightSql(sql: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of sql.matchAll(SQL_TOKEN)) {
    if (m.index! > last) out.push(document.createTextNode(sql.slice(last, m.index)));
    const t = m[0], span = document.createElement("span");
    span.textContent = t;
    span.style.color = /^['"`]/.test(t) ? (t[0] === "`" ? "inherit" : "var(--tok-string)") : t.startsWith("--") || t.startsWith("/*") ? "var(--tok-comment)" : /^\d/.test(t) ? "var(--tok-number)" : "var(--tok-keyword)";
    if (/^[a-z]/i.test(t)) span.style.fontWeight = "600";
    out.push(span);
    last = m.index! + t.length;
  }
  if (last < sql.length) out.push(document.createTextNode(sql.slice(last)));
  return out;
}

function renderLog() {
  const host = $("sqllog");
  const visible = logOpen && !!active && !launcherOpen;
  host.classList.toggle("hidden", !visible);
  $("sqllog-btn")?.setAttribute("aria-pressed", String(logOpen));
  if (!visible) return;
  const mine = logScope === "tab" && active ? active.id : null;
  const entries = (conn?.log ?? []).filter((e) => mine === null || e.tab === mine);
  const hl = localStorage.getItem("tabnix.logHl") !== "0";
  const head = document.createElement("div");
  head.className = "h-8 shrink-0 flex items-center gap-2 px-3 text-[12.5px] text-muted border-b border-line";
  head.innerHTML = `<span class="font-medium text-soft">SQL</span><span class="truncate">${esc(mine !== null ? active!.title : conn?.db ?? conn?.name ?? "")}</span><span class="flex-1"></span>`;
  const mk = (label: string, f: () => void) => { const b = document.createElement("button"); b.className = "btn btn-ghost"; b.style.height = "24px"; b.textContent = label; b.onclick = f; return b; };
  head.append(
    mk(logScope === "tab" ? "This tab" : "Whole database", () => { logScope = logScope === "tab" ? "db" : "tab"; localStorage.setItem("tabnix.logScope", logScope); renderLog(); }),
    mk(hl ? "Highlight: on" : "Highlight: off", () => { localStorage.setItem("tabnix.logHl", hl ? "0" : "1"); renderLog(); }),
    mk("Copy", () => { navigator.clipboard?.writeText(entries.map((e) => `-- ${new Date(e.at).toLocaleString()}\n${e.sql}`).join("\n\n")); toast("SQL log copied", "ok"); }),
    mk("Clear", () => { if (conn) conn.log = (conn.log ?? []).filter((e) => mine !== null && e.tab !== mine); renderLog(); }),
    mk("Close", toggleLog),
  );
  const body = document.createElement("div");
  body.className = "flex-1 min-h-0 overflow-auto px-3 py-2 mono text-[13px] select-text";
  for (const e of entries) {
    const stamp = document.createElement("div");
    stamp.className = "text-ok";
    stamp.textContent = `-- ${new Date(e.at).toLocaleTimeString()}${e.err ? ` · ${e.err}` : ` · ${e.ms} ms`}`;
    if (e.err) stamp.className = "text-danger";
    const q = document.createElement("div");
    q.className = "whitespace-pre-wrap break-words mb-2";
    if (hl) q.append(...highlightSql(e.sql)); else q.textContent = e.sql;
    body.append(stamp, q);
  }
  if (!entries.length) body.innerHTML = `<div class="text-muted">${mine !== null ? "Statements this tab runs will appear here." : "Statements you run on this database will appear here."}</div>`;
  host.replaceChildren(head, body);
  body.scrollTop = body.scrollHeight;
}

function toggleLog() {
  logOpen = !logOpen;
  localStorage.setItem("tabnix.logOpen", logOpen ? "1" : "0");
  renderLog();
}

// ---------- total row count, only when asked: COUNT(*) can be slow on big tables, so it never runs by itself ----------
const PAGE_ROWS = 1000; // what a table tab reads (see select_all_sql)

function offerCount(t: Tab, s: Summary) {
  const b = t.countBtn;
  if (!b) return;
  t.countSeq = (t.countSeq ?? 0) + 1; // a new result invalidates a count still running
  const more = t.kind === "table" && !!t.table && !!t.conn && !["redis", "mongo"].includes(t.conn.kind) && s.columns.length > 0 && s.row_count >= PAGE_ROWS;
  b.style.display = more ? "" : "none";
  if (!more) return;
  b.disabled = false;
  b.textContent = "Count all rows";
  b.title = "Run SELECT COUNT(*) for this table (can be slow on large tables)";
  b.onclick = () => countRows(t);
}

async function countRows(t: Tab) {
  const b = t.countBtn, c = t.conn;
  if (!b || !c || !t.table) return;
  const seq = t.countSeq;
  b.disabled = true; b.textContent = "Counting…";
  try {
    const o = c.objects.find((x) => x.name === t.table);
    const inner = await api.selectAllSql(c.id, o?.schema ?? null, t.table, 2_000_000_000, t.filterWhere);
    const sql = countSql(inner);
    if (!sql) throw new Error("can't count this object");
    const r = await api.runQuery(c.id, sql);
    logSql(c, sql, r.elapsed_ms, undefined, t);
    const rows = await api.getRows(r.query_id, 0, 1);
    api.release(r.query_id).catch(() => {});
    const v = rows[0]?.[0];
    const n = v && "v" in v ? Number(v.v) : NaN;
    if (seq !== t.countSeq) return;
    b.textContent = Number.isFinite(n) ? `${n.toLocaleString()} rows in total` : "Count unavailable";
    b.title = `SELECT COUNT(*) took ${r.elapsed_ms} ms — click to count again`;
    b.disabled = false;
  } catch (e) {
    if (seq !== t.countSeq) return;
    b.textContent = "Count failed — retry";
    b.title = String(e);
    b.disabled = false;
  }
}

/** Readable error block with a Copy button: first line in red, the rest in ink. */
function errorPanel(title: string, message: string, ms?: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "h-full overflow-auto p-5";
  const head = document.createElement("div");
  head.className = "flex items-center gap-2 mb-2";
  const ttl = document.createElement("span");
  ttl.className = "text-danger font-medium";
  ttl.textContent = title;
  head.append(ttl);
  if (ms != null) { const m = document.createElement("span"); m.className = "text-muted text-[12px]"; m.textContent = `${ms} ms`; head.append(m); }
  const sp = document.createElement("span"); sp.className = "flex-1";
  const copy = document.createElement("button");
  copy.className = "btn btn-ghost btn-sm";
  copy.textContent = "Copy";
  copy.onclick = () => { navigator.clipboard?.writeText(message); toast("Error copied", "ok"); };
  head.append(sp, copy);
  const pre = document.createElement("pre");
  pre.className = "mono text-[13px] whitespace-pre-wrap break-words select-text";
  pre.style.color = "var(--ink)";
  const nl = message.indexOf("\n");
  const first = document.createElement("span");
  first.className = "text-danger";
  first.textContent = nl < 0 ? message : message.slice(0, nl);
  pre.append(first, document.createTextNode(nl < 0 ? "" : message.slice(nl)));
  el.append(head, pre);
  return el;
}

async function exec(t: Tab, sqlText: string) {
  if (!t.conn) { t.status.textContent = "Not connected — open a database first (⌘O)"; return; }
  if (t.panel && t.gridWrap) { t.gridWrap.replaceChildren(t.grid.el); t.panel = undefined; }
  if (t.running) { t.status.textContent = "A query is already running — ⌘. to cancel"; return; }
  releaseResults(t);
  t.running = true; t.cancelled = false;
  if (t.countBtn) t.countBtn.style.display = "none";
  t.empty?.remove(); t.empty = undefined;
  if (t.gridWrap) { t.runBar = document.createElement("div"); t.runBar.className = "running-bar"; t.gridWrap.append(t.runBar); }
  t.status.textContent = "Running… (⌘. to cancel)";
  try {
    const s: Summary = await api.runQuery(t.conn.id, sqlText);
    logSql(t.conn, sqlText, s.elapsed_ms, undefined, t);
    t.lastMs = s.elapsed_ms; t.failed = false;
    await t.grid.setResult(s.columns.length ? s : null);
    if (t.kind === "query") prepareEdit(t);
    t.status.textContent = s.columns.length
      ? `${s.row_count.toLocaleString()} rows${s.truncated ? " (truncated)" : ""} · ${s.elapsed_ms} ms`
      : `${s.affected ?? 0} rows affected · ${s.elapsed_ms} ms`;
    offerCount(t, s);
    if (/^\s*(create|drop|alter)\b/i.test(sqlText)) refreshObjects();
  } catch (e) {
    t.failed = true;
    logSql(t.conn, sqlText, 0, t.cancelled ? "cancelled" : String(e).split("\n")[0], t);
    await t.grid.setResult(null);
    if (t.kind === "query") prepareEdit(t);
    t.status.textContent = t.cancelled ? "Query cancelled" : "Error: " + String(e).split("\n")[0];
    t.status.title = String(e);
    t.status.classList.toggle("text-danger", !t.cancelled);
    if (!t.cancelled && t.gridWrap) {
      const el = errorPanel("Query failed", String(e).replace(/^Error:\s*/, ""));
      t.panel = el;
      t.gridWrap.replaceChildren(el);
    }
    t.running = false; t.runBar?.remove();
    return;
  }
  t.running = false; t.runBar?.remove();
  t.status.classList.remove("text-danger");
  t.status.title = "";
}

const orig = (g: Grid, r: number, i: number): Val => g.original(r)?.[i] ?? { t: "Null" };

/** Where a tab's staged edits are written: its own table (table tabs) or the one table its query result maps to. */
function editTarget(t: Tab): EditTarget | null {
  if (t.kind === "query") return t.edit ?? null;
  return t.table && t.cols ? { table: t.table, schema: t.schemaName ?? null, cols: t.cols, map: [] } : null;
}

function buildChanges(t: Tab, target: EditTarget): Change[] | string {
  const g = t.grid, cols = target.cols;
  const src = (i: number) => target.map[i] ?? g.columns[i].name; // result columns can be aliases
  const pk = cols.map((c, i) => [c, i] as const).filter(([c]) => c.primary_key);
  const colIdx = (name: string) => (target.map.length ? target.map.indexOf(name) : g.columns.findIndex((c) => c.name === name));
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
    out.push({ kind: "update", key: key(r), set: [...m].map(([i, v]) => [src(i), typed(src(i), v)] as [string, Val]) });
  }
  for (const r of g.deleted) {
    if (!g.original(r)) return "Deleted rows must be loaded; scroll to them and try again.";
    out.push({ kind: "delete", key: key(r) });
  }
  const n = g.columns.length;
  g.inserted.forEach((row) => out.push({ kind: "insert", set: row.map((v, i) => [src(i), typed(src(i), v)] as [string, Val]).filter(([, v]) => v.t !== "Null") }));
  void n;
  return out;
}

/** Delete (stage the deletion of) the selected row, after asking. Un-marking a row or dropping a new unsaved row needs no question. */
async function deleteRow(t: Tab) {
  const g = t.grid;
  const n = g.selectedCount;
  if (!n) return;
  if (!g.hasDeletableSelection) { g.deleteSelected(); return; }
  const ok = await confirmDanger({
    title: n === 1 ? `Delete row ${g.selected + 1}?` : `Delete ${n.toLocaleString()} rows?`,
    body: `Marks ${n === 1 ? "the row" : `<b>${n.toLocaleString()} rows</b>`} for deletion from <b>${esc(t.table ?? "this table")}</b>. ${n === 1 ? "It is" : "They are"} removed from the database only when you commit (⌘S), after you review the SQL.`,
    confirmLabel: n === 1 ? "Delete row" : `Delete ${n.toLocaleString()} rows`,
  });
  if (ok) g.deleteSelected();
}

/** Copy the selected rows to the clipboard in one of the formats. */
async function copyRows(t: Tab, fmt: CopyFormat, header = false) {
  const g = t.grid;
  const rows = g.selectedRows();
  if (!rows.length) return;
  try {
    const kind = t.conn?.kind === "mariadb" ? "mysql" : t.conn?.kind ?? "";
    const text = formatRows(fmt, await g.rowValues(rows), { columns: g.columns.map((c) => c.name), table: t.table ?? "table_name", quote: quoteFor(t.conn), dialect: kind, header });
    await navigator.clipboard?.writeText(text);
    toast(`Copied ${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"} as ${{ tsv: "text", csv: "CSV", json: "JSON", markdown: "Markdown", sql: "SQL INSERT" }[fmt]}`, "ok");
  } catch (e) { toast("Couldn't copy: " + e, "error"); }
}

async function discardChanges(t: Tab) {
  if (!t.grid.pendingCount) return;
  const n = t.grid.pendingCount;
  if (await confirmDanger({ title: "Discard pending changes?", body: `${n} uncommitted change${n === 1 ? "" : "s"} will be thrown away.`, confirmLabel: "Discard" })) t.grid.discard();
}

/** Show the generated SQL and, on confirmation, run it in one transaction. */
async function commitChanges(t: Tab) {
  const target = editTarget(t);
  if (!t.conn || !target || !t.grid.pendingCount) return;
  const changes = buildChanges(t, target);
  if (typeof changes === "string") { t.status.textContent = changes; return; }
  try {
    const stmts = await api.applyChanges(t.conn.id, target.schema, target.table, changes, true);
    if (!(await confirmSql(stmts))) return;
    await api.applyChanges(t.conn.id, target.schema, target.table, changes, false);
    for (const q of stmts) logSql(t.conn, q, 0, undefined, t);
    t.grid.discard(); // staged changes are now in the database
    if (t.kind === "query") await rerunResult(t); else reload(t);
  } catch (e) {
    t.status.textContent = "Commit failed: " + e;
    t.status.classList.add("text-danger");
  }
}

/** Commit every table tab of the current database that has staged changes, after one review. Each tab is its own transaction. */
async function commitAll() {
  const c = conn;
  if (!c) return false;
  const dirty = tabs.filter((t) => t.kind === "table" && t.conn === c && t.grid.pendingCount);
  if (!dirty.length) { toast("No uncommitted changes in this database.", "info"); return; }
  const plan: { t: Tab; target: EditTarget; changes: Change[]; stmts: string[] }[] = [];
  try {
    for (const t of dirty) {
      const target = editTarget(t);
      if (!target) continue;
      const changes = buildChanges(t, target);
      if (typeof changes === "string") { toast(`${t.table}: ${changes}`, "error"); return; }
      plan.push({ t, target, changes, stmts: await api.applyChanges(c.id, target.schema, target.table, changes, true) });
    }
  } catch (e) { toast(`Couldn't prepare the commit: ${e}`, "error"); return; }
  if (!plan.length || !(await confirmSql(plan.flatMap((p) => [`-- ${p.target.table}`, ...p.stmts]), `Commit ${plan.length} table${plan.length === 1 ? "" : "s"}`))) return;
  let ok = 0;
  for (const p of plan) {
    try {
      await api.applyChanges(c.id, p.target.schema, p.target.table, p.changes, false);
      for (const q of p.stmts) logSql(c, q, 0, undefined, p.t);
      p.t.grid.discard(); reload(p.t); ok++;
    } catch (e) {
      toast(`Committed ${ok} of ${plan.length}. ${p.target.table} failed: ${e}`, "error");
      return;
    }
  }
  toast(`Committed changes to ${ok} table${ok === 1 ? "" : "s"}`, "ok");
}

/** Read a query result again after its edits were committed (a run-all result is replaced in place, the other results stay). */
async function rerunResult(t: Tab) {
  const c = t.conn, sqlText = t.baseSql;
  if (!c || !sqlText) return;
  if (t.results && t.resultIdx !== undefined) {
    const r = t.results[t.resultIdx];
    const s = await api.runQuery(c.id, r.sql);
    logSql(c, r.sql, s.elapsed_ms, undefined, t);
    if (r.summary) api.release(r.summary.query_id).catch(() => {});
    r.summary = s; r.affected = s.row_count; r.ms = s.elapsed_ms;
    await showResult(t, t.resultIdx);
    return;
  }
  const wrapped = t.sort.length ? wrapForSort(sqlText, t.sort, quoteFor(c)) : null;
  await exec(t, wrapped ?? sqlText);
}

/** Work out whether the result on show can be edited. Runs after every result of a query tab; a slow lookup for an older result is ignored. */
async function prepareEdit(t: Tab) {
  const seq = t.editSeq = (t.editSeq ?? 0) + 1;
  const g = t.grid, s = g.currentSummary;
  t.edit = undefined; g.editable = false; g.editCols = null; g.rowOps = false;
  let why = "";
  const c = t.conn;
  if (!s || !s.columns.length || !c || !t.baseSql) { paintEditBar(t, ""); return; }
  const a = ["redis", "mongo"].includes(c.kind) ? null : analyzeSelect(t.baseSql);
  if (!a) { paintEditBar(t, ""); return; }
  if (!a.ok) why = a.reason;
  else if (safetyOf(c.server) === "readonly") why = "this connection is read-only";
  else {
    const o = c.objects.find((x) => x.kind === "table" && x.name.toLowerCase() === a.table.toLowerCase() && (!a.schema || (x.schema ?? "").toLowerCase() === a.schema.toLowerCase()));
    if (!o) why = `${a.table} isn't a table in this database`;
    else {
      try {
        const d = await api.describe(c.id, o.schema ?? null, o.name);
        if (seq !== t.editSeq || g.currentSummary !== s) return;
        const r = resolveEdit(a, s.columns.map((x) => x.name), d.columns);
        if (!r.ok) why = r.reason;
        else {
          t.edit = { table: o.name, schema: o.schema ?? null, cols: d.columns, map: r.map };
          g.editCols = r.map.map((m) => !!m); g.editable = true;
        }
      } catch (e) { why = "couldn't read the table's structure"; }
    }
  }
  if (seq !== t.editSeq || g.currentSummary !== s) return;
  g.repaint();
  paintEditBar(t, why);
}

/** The strip under a query's editor: how to edit, why not, and Commit / Discard once there are staged changes. */
function paintEditBar(t: Tab, why?: string) {
  const bar = t.editBar;
  if (!bar) return;
  if (why !== undefined) bar.dataset.why = why;
  const n = t.grid.pendingCount, editable = !!t.edit;
  if (!t.grid.currentSummary || (!editable && !bar.dataset.why)) { bar.classList.add("hidden"); bar.replaceChildren(); return; }
  bar.classList.remove("hidden");
  const info = document.createElement("span");
  info.className = "hint text-muted truncate flex-1";
  info.textContent = editable ? (n ? `${n} pending change${n > 1 ? "s" : ""} in ${t.edit!.table}` : `Double-click a cell to edit ${t.edit!.table}`) : `Read-only: ${bar.dataset.why}`;
  bar.replaceChildren(info);
  if (!n) return;
  const mk = (label: string, ic: string, cls: string, f: () => void) => { const b = document.createElement("button"); b.className = cls; b.innerHTML = icon(ic, 14) + `<span>${label}</span>`; b.onclick = f; return b; };
  const prod = isCareful(t.conn?.env) && t.conn?.env === "production";
  bar.append(mk(`Commit ${n}`, "commit", prod ? "btn btn-careful" : "btn btn-primary", () => commitChanges(t)), mk("Discard", "undo", "btn", () => discardChanges(t)));
}

function confirmSql(stmts: string[], title?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const o = document.createElement("div");
    o.className = "fixed inset-0 bg-black/50 flex items-center justify-center z-50";
    o.dataset.modal = "";
    o.innerHTML = `<div class="w-[640px] max-h-[70vh] bg-raised rounded-lg border border-line-strong shadow-2xl flex flex-col">
      <div class="px-4 py-2 border-b border-line-strong font-semibold">${title ? `${title} (one transaction per table)` : `Review changes (${stmts.length} statement${stmts.length > 1 ? "s" : ""}, one transaction)`}</div>
      <pre class="mono text-[13px] p-4 overflow-auto flex-1 select-text whitespace-pre-wrap"></pre>
      <div class="p-3 flex justify-end gap-2 border-t border-line-strong">
        <button id="no" class="px-3 py-1 rounded hover:bg-raised2">Cancel</button>
        <button id="yes" class="px-3 py-1 rounded btn-primary">Commit</button></div></div>`;
    o.querySelector("pre")!.textContent = stmts.join("\n");
    const done = (v: boolean) => { o.remove(); window.removeEventListener("keydown", key, true); resolve(v); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); done(true); }
    };
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

/** Header sort: apply the new sort and re-read. Table tabs sort on the server; query results re-run wrapped in a SELECT. */
function applySort(t: Tab, next: SortKey[]) {
  if (!t.conn) return;
  if (t.grid.pendingCount) { t.status.textContent = "Commit (⌘S) or discard pending changes before sorting"; return; }
  if (t.kind === "table") { t.sort = next; t.grid.sort = next; reload(t); return; }
  if (t.kind === "query") {
    if (!t.baseSql) return;
    if (!next.length) { t.sort = []; t.grid.sort = []; exec(t, t.baseSql); return; }
    const wrapped = wrapForSort(t.baseSql, next, quoteFor(t.conn));
    if (!wrapped) { toast("This statement can't be sorted from the header. Add an ORDER BY to the query.", "info"); return; }
    t.sort = next; t.grid.sort = next;
    exec(t, wrapped);
  }
}

/** Right-click on a result cell: filter by or exclude its value, copy, set to NULL. */
function cellMenu(t: Tab, x: number, y: number, r: number, c: number) {
  const g = t.grid;
  const col = g.columnName(c), v = g.valueAt(r, c);
  if (!v) return;
  const isNull = v.t === "Null";
  const pg = !["mysql", "mariadb", "mssql", "sqlite"].includes(t.conn?.kind ?? "");
  const text = v.t === "Bool" ? (pg ? String(v.v) : v.v ? "1" : "0") : show(v);
  const short = (isNull ? "NULL" : text.length > 24 ? text.slice(0, 24) + "…" : text);
  const canFilter = t.kind === "table" && !!t.filterBar;
  const rule = (op: FilterRule["op"]): FilterRule => ({ col, op, value: text });
  contextMenu(x, y, [
    { label: isNull ? `Show only rows where ${col} is NULL` : `Show only ${col} = ${short}`, disabled: !canFilter, action: () => t.filterBar?.addRule(isNull ? { col, op: "is null", value: "" } : rule("=")) },
    { label: isNull ? `Hide rows where ${col} is NULL` : `Hide rows where ${col} = ${short}`, disabled: !canFilter, action: () => t.filterBar?.addRule(isNull ? { col, op: "is not null", value: "" } : rule("<>")) },
    { divider: true, label: "" },
    { label: "Copy value", hint: "⌘C", action: () => { navigator.clipboard?.writeText(isNull ? "" : show(v)); toast("Copied", "ok"); } },
    { label: g.selectedCount > 1 ? `Copy ${g.selectedCount.toLocaleString()} rows` : "Copy row", action: () => copyRows(t, "tsv") },
    { label: "Copy as CSV", action: () => copyRows(t, "csv", true) },
    { label: "Copy as JSON", action: () => copyRows(t, "json") },
    { label: "Copy as Markdown", action: () => copyRows(t, "markdown") },
    { label: "Copy as SQL INSERT", disabled: ["redis", "mongo"].includes(t.conn?.kind ?? ""), action: () => copyRows(t, "sql") },
    { label: "Copy with column names", action: () => copyRows(t, "tsv", true) },
    { label: "Copy column name", action: () => { navigator.clipboard?.writeText(col); toast("Copied " + col, "ok"); } },
    { divider: true, label: "" },
    { label: "Set to NULL", disabled: !g.canEditCell(c) || isNull, action: () => g.stageEdit(r, c, { t: "Null" }) },
    { label: g.selectedCount > 1 ? `Delete ${g.selectedCount.toLocaleString()} rows…` : "Delete row…", danger: true, disabled: !g.editable || !g.rowOps, action: () => deleteRow(t) },
  ]);
}

function currentSql(t: Tab): string {
  const view = t.editor!;
  const sel = view.state.selection.main;
  if (!sel.empty) return view.state.sliceDoc(sel.from, sel.to);
  // The statement under the cursor (quote- and comment-aware split on ;), falling back to the whole editor.
  const doc = view.state.doc.toString();
  return statementAt(doc, sel.head)?.text ?? doc.trim();
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

/** ⌘↵ runs the selection, or the statement under the cursor; ⌘⇧↵ runs every statement in the selection / editor. */
function runActive(all = false) {
  const t = active;
  if (!t || t.kind === "diagram") return;
  if (t.kind === "table") return reload(t);
  const view = t.editor!;
  const sel = view.state.selection.main;
  const text = all ? (sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to)) : currentSql(t);
  if (!text.trim()) return;
  const n = t.grid.pendingCount;
  const keep = n ? confirmDanger({ title: "Discard pending changes?", body: `Running again replaces this result, so ${n} uncommitted change${n === 1 ? "" : "s"} will be thrown away.`, confirmLabel: "Discard and run" }) : Promise.resolve(true);
  keep.then((go) => go && guardRun(t, text)).then((ok) => { if (ok) (all ? execAll(t, text) : execOne(t, text)); });
}

function execOne(t: Tab, text: string) {
  t.baseSql = text; t.sort = detectSort(text); t.grid.sort = t.sort;
  const started = Date.now();
  exec(t, text).then(() => { if (t.conn) { recordHistory(t.conn, { sql: text, at: started, ms: t.lastMs ?? Date.now() - started, ok: !t.failed }); if (sideView === "history") renderObjects(); } });
}

/** Safety checks before typed SQL runs: read-only refuses writes, protected asks first, destructive statements always ask. */
async function guardRun(t: Tab, text: string): Promise<boolean> {
  const level = t.conn ? safetyOf(t.conn.server) : "off";
  if (level === "readonly" && !isReadOnlySql(text)) { toast(`${t.conn!.server.name} is read-only: this statement would change data and was not run.`, "error"); return false; }
  const d = destructiveKind(text);
  if (!d && level === "protected" && !isReadOnlySql(text)) {
    return confirmDanger({ title: "Run this write on a protected connection?", body: `<b>${esc(t.conn!.server.name)}</b> is protected. This changes data or structure.`, confirmLabel: "Run", sql: [text.trim().slice(0, 600)] });
  }
  if (!d) return true;
  if (t.conn && (d.kind === "drop" || d.kind === "truncate") && blocked(t.conn.server, d.kind === "drop" ? "DROP statements" : "TRUNCATE")) return false;
  const what = { drop: "drops an object", truncate: "empties a table", "delete-all": "deletes every row (no WHERE)", "update-all": "changes every row (no WHERE)" }[d.kind];
  return confirmDanger({ title: "Run this statement?", body: `This ${what}${t.conn ? ` on <b>${esc(t.conn.db ?? t.conn.name)}</b>` : ""}. It cannot be undone.`, confirmLabel: "Run statement", sql: [d.statement] });
}

// ---------- run all statements: one result per statement ----------
const MAX_KEPT_RESULTS = 12; // row sets stay in Rust until the next run, so keep the number bounded

function releaseResults(t: Tab) {
  for (const r of t.results ?? []) if (r.summary && r.summary !== t.grid.currentSummary) api.release(r.summary.query_id).catch(() => {});
  t.results = undefined; t.resultIdx = undefined;
  t.resultBar?.classList.add("hidden");
}

async function execAll(t: Tab, text: string) {
  const c = t.conn;
  const stmts = splitStatements(text);
  if (!c || !stmts.length) return;
  if (stmts.length === 1) return execOne(t, stmts[0].text);
  if (t.running) { t.status.textContent = "A query is already running — ⌘. to cancel"; return; }
  releaseResults(t);
  t.running = true; t.cancelled = false; t.failed = false;
  t.empty?.remove(); t.empty = undefined;
  if (t.gridWrap) { t.runBar = document.createElement("div"); t.runBar.className = "running-bar"; t.gridWrap.append(t.runBar); }
  t.status.classList.remove("text-danger");
  const results: StmtResult[] = [];
  const started = Date.now();
  let kept = 0;
  for (const [i, st] of stmts.entries()) {
    t.status.textContent = `Running statement ${i + 1} of ${stmts.length}… (⌘. to cancel)`;
    const at = Date.now();
    try {
      const s = await api.runQuery(c.id, st.text);
      logSql(c, st.text, s.elapsed_ms, undefined, t);
      recordHistory(c, { sql: st.text, at, ms: s.elapsed_ms, ok: true });
      const rows = s.columns.length > 0 && kept < MAX_KEPT_RESULTS;
      if (rows) kept++; else api.release(s.query_id).catch(() => {});
      results.push({ sql: st.text, summary: rows ? s : null, affected: s.columns.length ? s.row_count : s.affected ?? 0, ms: s.elapsed_ms });
    } catch (e) {
      logSql(c, st.text, 0, t.cancelled ? "cancelled" : String(e).split("\n")[0], t);
      recordHistory(c, { sql: st.text, at, ms: 0, ok: false });
      results.push({ sql: st.text, summary: null, error: String(e).replace(/^Error:\s*/, "") });
      t.failed = true;
      break;
    }
    if (t.cancelled) break;
  }
  t.running = false; t.runBar?.remove();
  t.results = results;
  const firstRows = results.findIndex((r) => r.summary);
  const failed = results.findIndex((r) => r.error);
  await showResult(t, failed >= 0 ? failed : firstRows >= 0 ? firstRows : results.length - 1);
  const done = results.filter((r) => !r.error).length;
  t.status.textContent = `${done} of ${stmts.length} statements ran · ${((Date.now() - started) / 1000).toFixed(2)} s${t.cancelled ? " · cancelled" : ""}`;
  t.status.classList.toggle("text-danger", failed >= 0);
  if (sideView === "history") renderObjects();
}

/** Show one of the results of the last run-all in the grid (or its message / error). */
async function showResult(t: Tab, i: number) {
  const r = t.results?.[i];
  if (!r || !t.gridWrap) return;
  t.resultIdx = i;
  t.baseSql = r.sql; t.sort = []; t.grid.sort = [];
  if (r.summary) {
    if (t.panel) { t.gridWrap.replaceChildren(t.grid.el); t.panel = undefined; }
    await t.grid.setResult(r.summary, false);
    prepareEdit(t);
  } else {
    await t.grid.setResult(null, false);
    prepareEdit(t);
    const el = r.error ? errorPanel("This statement failed", r.error) : document.createElement("div");
    el.className = "h-full overflow-auto p-5";
    if (!r.error) {
    const head = document.createElement("div");
    head.className = r.error ? "text-danger font-medium mb-2" : "text-soft mb-2";
    head.textContent = r.error ? "This statement failed" : `${(r.affected ?? 0).toLocaleString()} row${r.affected === 1 ? "" : "s"} affected · ${r.ms} ms`;
    const pre = document.createElement("pre");
    pre.className = "mono text-[13px] whitespace-pre-wrap break-words select-text " + (r.error ? "text-danger" : "text-muted");
    pre.textContent = r.error ?? r.sql;
    el.append(head, pre);
    }
    t.panel = el;
    t.gridWrap.replaceChildren(el);
  }
  renderResultBar(t);
}

function renderResultBar(t: Tab) {
  const bar = t.resultBar, rs = t.results;
  if (!bar || !rs || rs.length < 2) { bar?.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  const seg = document.createElement("div");
  seg.className = "seg";
  rs.forEach((r, i) => {
    const b = document.createElement("button");
    const label = r.error ? "error" : r.summary ? `${(r.affected ?? 0).toLocaleString()} rows` : `${(r.affected ?? 0).toLocaleString()} affected`;
    b.textContent = `${i + 1} · ${label}`;
    b.title = r.sql;
    b.setAttribute("aria-pressed", String(i === t.resultIdx));
    if (r.error) b.style.color = "var(--danger)";
    b.onclick = () => showResult(t, i);
    seg.append(b);
  });
  bar.replaceChildren(seg);
}

function reload(t: Tab) {
  if (t.kind === "diagram") return loadDiagram(t);
  if (t.kind === "table" && t.table && t.conn) {
    const o = t.conn.objects.find((x) => x.name === t.table);
    t.schemaName = o?.schema ?? null;
    if (t.grid.pendingCount) { t.status.textContent = "Commit (⌘S) or discard pending changes before reloading"; return; }
    api.describe(t.conn.id, t.schemaName, t.table)
      .then((d) => { t.cols = d.columns; t.grid.editable = o?.kind !== "view" && safetyOf(t.conn!.server) !== "readonly" && d.columns.some((c) => c.primary_key); })
      .catch(() => { t.grid.editable = false; })
      .then(() => api.selectAllSql(t.conn!.id, t.schemaName ?? null, t.table!, undefined, t.filterWhere, buildOrder(t.sort, quoteFor(t.conn)) || undefined))
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
  // Functions, procedures, triggers and events: one small catalog query, after the tables are already on screen.
  api.listRoutines(c.id).then((r) => { c.routines = r; renderObjects(); }).catch(() => { c.routines = []; });
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
interface RowOpts { level: number; ic: string; label: string; sub?: string; badge?: string; stripe?: string; chevron?: "open" | "shut"; count?: number; active?: boolean; strong?: boolean; muted?: boolean; actions?: { ic: string; title: string; fn: () => void }[]; click?: (e: MouseEvent) => void; dbl?: () => void; menu?: (x: number, y: number) => void; title?: string; selected?: boolean; dirty?: number; name?: string }
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
    if (o.selected) d.dataset.selected = "true";
    if (o.dirty) d.dataset.dirty = "true";
    if (o.name !== undefined) d.dataset.name = o.name;
    d.innerHTML = chev + `<span class="${o.active ? "" : "text-muted"} shrink-0">${icon(o.ic, 15)}</span>` +
      `<span class="min-w-0 flex-1 truncate ${o.level === 2 ? "text-soft font-medium text-[13px]" : ""} ${o.level === 1 ? "font-medium" : ""} ${o.muted ? "text-muted" : ""}">${esc(o.label)}</span>` +
      (o.count !== undefined ? `<span class="text-muted text-[12px] shrink-0 group-hover:hidden">${o.count}</span>` : "");
  }
  if (o.title) d.title = o.title;
  if (o.dirty) d.title = `${o.dirty} uncommitted change${o.dirty === 1 ? "" : "s"}`;
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
const ART_TABNIX = `<svg viewBox="0 0 150 110" width="150" height="110" fill="none" aria-hidden="true"><g fill="currentColor" opacity=".32">${[0, 1, 2, 3, 4].flatMap((i) => [0, 1, 2, 3].map((j) => `<circle cx="${14 + i * 30}" cy="${14 + j * 27}" r="3.2"/>`)).join("")}</g>
  <g stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="44" y="26" width="62" height="54" rx="7" fill="var(--panel)"/><path d="M44 42h62M64 42v38M85 42v38M44 58h62" opacity=".75"/></g>
  <circle cx="134" cy="14" r="6" fill="var(--spark)"/><path d="M106 33 129 17" stroke="var(--spark)" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const ART_RESULTS = `<svg viewBox="0 0 120 80" width="120" height="80" fill="none" aria-hidden="true"><g fill="var(--accent)" opacity=".14"><rect x="8" y="30" width="104" height="11" rx="5"/><rect x="8" y="48" width="104" height="11" rx="5"/><rect x="8" y="66" width="70" height="11" rx="5"/></g>
  <rect x="14" y="6" width="2.6" height="18" rx="1.3" fill="var(--accent)"><animate attributeName="opacity" values="1;0.15;1" dur="1.2s" repeatCount="indefinite"/></rect><rect x="22" y="12" width="36" height="6" rx="3" fill="var(--spark)" opacity=".85"/></svg>`;

/** Tables picked in the sidebar (⌘/Ctrl-click, Shift-click) for a bulk action. Belongs to one database. */
let sel: Selection = { picked: new Set(), anchor: null };
let selConn: Conn | null = null;
const objKey = (o: ObjectRef) => (o.schema ? o.schema + "." : "") + o.name;
const selectedObjects = (c: Conn) => (selConn === c ? c.objects.filter((o) => sel.picked.has(objKey(o))) : []);
function clearSelection() { sel = { picked: new Set(), anchor: null }; selConn = null; }

/** Open table tabs with staged edits, as table name -> change count, for one database. */
function dirtyTables(c: Conn | null) {
  const m = new Map<string, number>();
  for (const t of tabs) if (c && t.kind === "table" && t.conn === c && t.table && t.grid.pendingCount) m.set(t.table, (m.get(t.table) ?? 0) + t.grid.pendingCount);
  return m;
}
/** Re-mark the yellow "uncommitted" rows in place, without rebuilding the tree. */
function syncDirtyRows() {
  const dirty = dirtyTables(conn);
  document.querySelectorAll<HTMLElement>("#objects [data-name]").forEach((row) => {
    const n = dirty.get(row.dataset.name!);
    if (n) { row.dataset.dirty = "true"; row.title = `${n} uncommitted change${n === 1 ? "" : "s"}`; }
    else if (row.dataset.dirty) { delete row.dataset.dirty; row.title = "Double-click to open"; }
  });
}

const KIND_GROUPS: [string, string, string][] = [["table", "Tables", "table"], ["view", "Views", "view"], ["collection", "Collections", "collection"], ["key", "Keys", "key"], ["function", "Functions", "structure"], ["procedure", "Procedures", "play"], ["trigger", "Triggers", "wand"], ["event", "Events", "sun"]];
const ROUTINE_KINDS = ["function", "procedure", "trigger", "event"];

// ---------- sidebar views: Items (tables, …) | Queries (saved) | History ----------
type SideView = "items" | "queries" | "history";
let sideView: SideView = (localStorage.getItem("tabnix.sideView") as SideView) || "items";
const SIDE_PLACEHOLDER: Record<SideView, string> = { items: "Search tables", queries: "Search favorites", history: "Search history" };

function renderSideTabs() {
  const host = $("sidetabs");
  host.replaceChildren(...(["items", "queries", "history"] as SideView[]).map((v) => {
    const b = document.createElement("button");
    b.textContent = { items: "Items", queries: "Favorites", history: "History" }[v];
    b.style.flex = "1";
    b.setAttribute("aria-pressed", String(sideView === v));
    b.onclick = () => { sideView = v; localStorage.setItem("tabnix.sideView", v); $<HTMLInputElement>("filter").placeholder = SIDE_PLACEHOLDER[v]; renderSideTabs(); renderObjects(); };
    return b;
  }));
  $<HTMLInputElement>("filter").placeholder = SIDE_PLACEHOLDER[sideView];
}

const oneLine = (sql: string, n = 90) => { const t = sql.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
/** History lives in memory for as long as the database stays open; it is never written to disk. */
function recordHistory(c: Conn, item: HistoryItem) { c.history = pushHistory(c.history ?? [], item); }

// ---------- drafts: open query tabs are saved as you type and come back when the database is opened again ----------
const draftKey = (c: Conn) => sessionKey(c.server.id, c.db);
function flushDraft(t: Tab) {
  clearTimeout(t.draftTimer); t.draftTimer = undefined;
  if (t.kind !== "query" || !t.conn || !t.editor) return;
  saveDraft(draftKey(t.conn), t.draftId, t.title, t.editor.state.doc.toString());
}
function scheduleDraft(t: Tab) {
  clearTimeout(t.draftTimer);
  t.draftTimer = window.setTimeout(() => flushDraft(t), 500);
}
window.addEventListener("pagehide", () => { for (const t of tabs) flushDraft(t); });
dropLegacyHistory();

/** New query tab holding `sql` (nothing is run). */
function openQueryTab(c: Conn, sql: string, title = "Query", draftId?: string) {
  const t = makeTab("query", title, undefined, c);
  if (draftId) t.draftId = draftId;
  // Keep the "Results appear here" state, but not the Recent list: clicking one would replace this tab's text.
  t.empty?.querySelector("[data-recent]")?.remove();
  t.shown = undefined; // nothing was shown, so closing this tab must not forget any recent session
  t.editor?.dispatch({ changes: { from: 0, to: t.editor.state.doc.length, insert: sql }, selection: { anchor: sql.length } });
  return t;
}

function sideHeader(title: string, action?: { label: string; fn: () => void }): HTMLElement {
  const h = document.createElement("div");
  h.className = "flex items-center px-3 h-8 text-[12px] uppercase tracking-wide text-muted";
  h.innerHTML = `<span class="flex-1">${esc(title)}</span>`;
  if (action) { const b = document.createElement("button"); b.className = "normal-case tracking-normal text-accent hover:underline"; b.textContent = action.label; b.onclick = action.fn; h.append(b); }
  return h;
}

function sideRow(title: string, sub: string, o: { click: () => void; menu: (x: number, y: number) => void; tone?: "bad"; star?: { on: boolean; fn: () => void } }): HTMLElement {
  const d = document.createElement("div");
  d.className = "group px-3 py-1.5 rounded-lg cursor-default hover:bg-raised flex items-center gap-2";
  d.innerHTML = `<div class="flex-1 min-w-0"><div class="truncate ${o.tone === "bad" ? "text-danger" : ""}"></div><div class="text-[12px] text-muted truncate"></div></div>`;
  (d.firstElementChild!.children[0] as HTMLElement).textContent = title;
  (d.firstElementChild!.children[1] as HTMLElement).textContent = sub;
  d.title = title;
  d.onclick = o.click;
  d.oncontextmenu = (e) => { e.preventDefault(); o.menu(e.clientX, e.clientY); };
  if (o.star) {
    const b = document.createElement("button");
    b.className = "shrink-0 rounded p-1 " + (o.star.on ? "text-warn" : "text-muted opacity-0 group-hover:opacity-100 hover:text-warn");
    b.innerHTML = icon("star", 15, "", o.star.on);
    b.title = o.star.on ? "Remove from favorites" : "Add to favorites";
    b.onclick = (e) => { e.stopPropagation(); o.star!.fn(); };
    d.append(b);
  }
  return d;
}

/** Ask, then drop a favourite. */
async function removeFavorite(pid: string, f: { id: string; name: string }) {
  if (!(await confirmDanger({ title: `Remove “${oneLine(f.name, 40)}” from favorites?`, body: "The saved query is deleted. Its text stays in any open tab.", confirmLabel: "Remove" }))) return false;
  deleteQuery(pid, f.id);
  renderObjects();
  return true;
}

function renderSavedQueries() {
  const host = $("objects");
  const c = conn ?? activeServer?.conns[0] ?? null;
  const q = $<HTMLInputElement>("filter").value.trim().toLowerCase();
  const pid = activeServer?.id;
  if (!pid) { host.innerHTML = `<div class="px-3 py-6 text-muted text-center">Connect to a database to use favorites.</div>`; return; }
  const list = loadSaved(pid).filter((s) => !q || s.name.toLowerCase().includes(q) || s.sql.toLowerCase().includes(q));
  const frag = document.createDocumentFragment();
  frag.append(sideHeader(`Favorites on ${activeServer!.name}`, { label: "☆ Add current", fn: () => favoriteCurrentQuery() }));
  for (const s of list) {
    frag.append(sideRow(s.name, oneLine(s.sql), {
      click: () => c && openQueryTab(c, s.sql, s.name),
      star: { on: true, fn: () => removeFavorite(pid, s) },
      menu: (x, y) => contextMenu(x, y, [
        { label: "Open in new tab", action: () => c && openQueryTab(c, s.sql, s.name) },
        { label: "Copy SQL", action: () => { navigator.clipboard?.writeText(s.sql); toast("Copied", "ok"); } },
        { label: "Rename…", action: async () => { const n = await promptName("Rename favorite", s.name, "Rename", s.name); if (n) { renameQuery(pid, s.id, n); renderObjects(); } } },
        { divider: true, label: "" },
        { label: "Remove from favorites…", danger: true, action: () => removeFavorite(pid, s) },
      ]),
    }));
  }
  if (!list.length) { const e = document.createElement("div"); e.className = "px-3 py-6 text-muted text-center"; e.textContent = q ? "No matches." : "No favorites yet. Press ⌘⇧S in a query tab, or star a query in History."; frag.append(e); }
  host.replaceChildren(frag);
}

/** ⌘⇧S: add the editor text of the active query tab to the favorites, no questions asked. */
function favoriteCurrentQuery() {
  const t = active;
  const pid = t?.conn?.server.id ?? activeServer?.id;
  if (!pid) return;
  const sql = t?.kind === "query" && t.editor ? t.editor.state.doc.toString().trim() : "";
  if (!sql) { toast("Open a query tab with some SQL first.", "info"); return; }
  const r = addFavorite(pid, sql);
  toast(r.added ? `Added to favorites: “${oneLine(r.fav.name, 40)}”` : "Already in favorites", r.added ? "ok" : "info");
  if (sideView !== "items") renderObjects();
}

function renderHistory() {
  const host = $("objects");
  const c = conn;
  const q = $<HTMLInputElement>("filter").value.trim().toLowerCase();
  if (!c) { host.innerHTML = `<div class="px-3 py-6 text-muted text-center">Open a database to see its history.</div>`; return; }
  const pid = c.server.id;
  const all = c.history ?? [];
  const list = all.filter((h) => !q || h.sql.toLowerCase().includes(q));
  const frag = document.createDocumentFragment();
  frag.append(sideHeader(`This session · ${c.db ?? c.name}`, all.length ? { label: "Clear", fn: async () => { if (await confirmDanger({ title: "Clear history?", body: `Forgets the queries run on <b>${esc(c.db ?? c.name)}</b> in this session. Favorites are kept.`, confirmLabel: "Clear history" })) { c.history = []; renderObjects(); } } } : undefined));
  for (const h of list) {
    const fav = findFavorite(pid, h.sql);
    frag.append(sideRow(oneLine(h.sql), `${ago(h.at)} · ${h.ok ? `${h.ms} ms` : "failed"}`, {
      tone: h.ok ? undefined : "bad",
      click: () => openQueryTab(c, h.sql),
      star: { on: !!fav, fn: () => { if (fav) removeFavorite(pid, fav).then(() => renderObjects()); else { addFavorite(pid, h.sql); toast("Added to favorites", "ok"); renderObjects(); } } },
      menu: (x, y) => contextMenu(x, y, [
        { label: "Open in new tab", action: () => openQueryTab(c, h.sql) },
        { label: "Copy SQL", action: () => { navigator.clipboard?.writeText(h.sql); toast("Copied", "ok"); } },
        { label: fav ? "Remove from favorites…" : "Add to favorites", action: () => { if (fav) removeFavorite(pid, fav).then(() => renderObjects()); else { addFavorite(pid, h.sql); toast("Added to favorites", "ok"); renderObjects(); } } },
        { divider: true, label: "" },
        { label: "Remove from history", action: () => { c.history = (c.history ?? []).filter((x) => x !== h); renderObjects(); } },
      ]),
    }));
  }
  if (!list.length) { const e = document.createElement("div"); e.className = "px-3 py-6 text-muted text-center"; e.textContent = q ? "No matches." : "Queries you run in a query tab show up here until you close the database."; frag.append(e); }
  host.replaceChildren(frag);
}

function renderObjects() {
  const host = $("objects");
  if (!activeServer) {
    const some = servers.length > 0;
    host.innerHTML = `<div class="px-4 py-10 text-center"><div class="inline-flex text-muted mb-2">${icon("database", 26)}</div><div class="font-medium">${some ? "Choose a connection" : "No connections open"}</div><div class="text-soft mt-0.5 mb-3">${some ? "Pick one from the strip on the left." : "Connect to a database to browse its tables."}</div><button id="emptyconn" class="btn btn-primary">${icon("plug", 14)}<span>Connect</span></button></div>`;
    ($("emptyconn")).onclick = () => showLauncher();
    return;
  }
  if (sideView === "queries") return renderSavedQueries();
  if (sideView === "history") return renderHistory();
  const q = $<HTMLInputElement>("filter").value.trim().toLowerCase();
  const openTab = active?.kind === "table" ? active : null;
  const frag = document.createDocumentFragment();
  let any = false;
  for (const s of activeServer ? [activeServer] : []) {
    const sKey = "s:" + s.id, sOpen = q ? true : !collapsed.has(sKey);
    const children: HTMLElement[] = [];
    for (const c of s.conns) {
      if (c !== conn) continue; // each database is its own workspace: the sidebar shows only the one on screen
      const items = [...c.objects, ...(c.routines ?? [])].filter((o) => !q || o.name.toLowerCase().includes(q));
      if (q && !items.length && !(c.db ?? "").toLowerCase().includes(q)) continue;
      const dKey = "d:" + c.id, dOpen = q ? true : !collapsed.has(dKey);
      const here = conn === c;
      const order = KIND_GROUPS.flatMap(([k]) => (ROUTINE_KINDS.includes(k) ? [] : items.filter((o) => o.kind === k).map(objKey)));
      if (selConn !== c) clearSelection();
      else if (sel.picked.size) { const seen = new Set(order); sel = { picked: new Set([...sel.picked].filter((k) => seen.has(k))), anchor: sel.anchor }; }
      const dirty = dirtyTables(c);
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
            selected: sel.picked.has(objKey(o)), dirty: dirty.get(o.name), name: o.name,
            click: (e) => {
              if (ROUTINE_KINDS.includes(o.kind)) { conn = c; renderObjects(); return; }
              const mode = e.shiftKey ? "range" : e.metaKey || e.ctrlKey ? "toggle" : "single";
              const same = mode === "single" && conn === c && selConn === c && sel.picked.size === 1 && sel.picked.has(objKey(o));
              conn = c; selConn = c; sel = clickSelect(sel, order, objKey(o), mode);
              if (!same) renderObjects(); // a repeated plain click keeps its row, so a double-click still lands
            },
            dbl: () => (ROUTINE_KINDS.includes(o.kind) ? showDefinition(c, o) : openTable(o.name, c)),
            menu: (x, y) => {
              if (ROUTINE_KINDS.includes(o.kind)) return routineMenu(c, o, x, y);
              if (selConn !== c || !sel.picked.has(objKey(o))) { selConn = c; sel = clickSelect(sel, order, objKey(o), "single"); renderObjects(); }
              const picked = selectedObjects(c);
              picked.length > 1 ? bulkMenu(c, picked, x, y) : tableMenu(c, o, x, y);
            },
          }));
        }
      }
      if (!items.length && !q) { const l = document.createElement("div"); l.className = "pl-14 h-[26px] leading-[26px] text-muted"; l.textContent = c.loading ? "Reading tables…" : "No tables yet"; children.push(l); }
    }
    if (!q && sOpen && s.dbs.length) {
      children.push(treeRow({ level: 1, ic: "plus", label: s.conns.length ? "Open another database…" : "Open a database…", muted: !!s.conns.length, strong: !s.conns.length, click: () => pickAndOpen(s) }));
      if (canManageDatabases(s.kind)) children.push(treeRow({ level: 1, ic: "database", label: "New database…", muted: true, click: () => createDatabase(s) }));
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

function routineMenu(c: Conn, o: ObjectRef, x: number, y: number) {
  contextMenu(x, y, [
    { label: "Show definition", action: () => showDefinition(c, o) },
    { label: "Copy name", action: () => { navigator.clipboard?.writeText(o.name); toast("Copied " + o.name, "ok"); } },
    { divider: true, label: "" },
    { label: "Refresh", action: () => refreshDatabase(c) },
  ]);
}

/** Open the CREATE statement of a function / procedure / trigger / event in a new query tab. */
async function showDefinition(c: Conn, o: ObjectRef) {
  try {
    const text = await api.objectDefinition(c.id, o.kind, o.schema, o.name);
    openQueryTab(c, text, o.name);
  } catch (e) { toast(`Couldn't read the definition of ${o.name}: ${e}`, "error"); }
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
    ...(dirtyTables(c).has(o.name) ? [{ divider: true, label: "" }, { label: "Commit changes", action: () => { const t = tabs.find((k) => k.kind === "table" && k.table === o.name && k.conn === c && k.grid.pendingCount); if (t) commitChanges(t); } }, { label: "Discard changes", action: () => { const t = tabs.find((k) => k.kind === "table" && k.table === o.name && k.conn === c && k.grid.pendingCount); if (t) discardChanges(t); } }] : []),
    { divider: true, label: "" },
    { label: isProtected(c.server) ? "Truncate… (protected)" : "Truncate…", danger: true, disabled: o.kind === "view" || ["redis", "mongo"].includes(c.kind), action: () => truncateTable(c, o) },
    { label: (o.kind === "view" ? "Drop view…" : "Drop table…") + (isProtected(c.server) ? " (protected)" : ""), danger: true, disabled: ["redis", "mongo"].includes(c.kind), action: () => dropTable(c, o) },
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
    { label: "Open again in a new workspace", disabled: !c.server.dbs.length, action: () => openDatabaseOn(c.server, c.db!, true) },
    { label: "New database…", disabled: !canManageDatabases(c.kind), action: () => createDatabase(c.server) },
    { divider: true, label: "" },
    { label: isProtected(c.server) ? "Truncate all tables… (protected)" : "Truncate all tables…", danger: true, disabled: !canTruncateAll(c.kind), action: () => truncateDatabase(c) },
    { label: isProtected(c.server) ? "Drop database… (protected)" : "Drop database…", danger: true, disabled: !canManageDatabases(c.kind) || !c.db || SYSTEM_DBS.has(c.db.toLowerCase()), action: () => dropDatabase(c.server, c.db!) },
    { divider: true, label: "" },
    { label: "Close this database", action: () => closeDatabase(c) },
  ]);
}

function serverMenu(s: Server, x: number, y: number) {
  contextMenu(x, y, [
    { label: "New query", disabled: !s.conns.length, action: () => makeTab("query", "Query", undefined, s.conns[0]) },
    { label: s.conns.length ? "Open another database…" : "Open a database…", disabled: !s.dbs.length, action: () => pickAndOpen(s) },
    { label: "New database…", disabled: !canManageDatabases(s.kind), action: () => createDatabase(s) },
    { label: "Refresh", action: () => s.conns.forEach(refreshDatabase) },
    { divider: true, label: "" },
    { label: "Disconnect", danger: true, action: () => disconnectServer(s) },
  ]);
}

// ---------- connection lifecycle ----------
function afterWorkspaceChange() {
  renderTabs();
  if (!wsTabs().length) { active = null; showHome(); }
}

/** Register an open database under its server and load its tables. */
async function addDatabase(s: Server, connId: number, db: string | null): Promise<Conn> {
  const c: Conn = { id: connId, name: s.name, kind: s.kind, env: s.env, db, dbs: s.dbs, objects: [], schema: [], server: s, loading: true };
  s.conns.push(c);
  if (safetyOf(s) === "readonly") api.setReadOnly(connId, true).catch(() => {}); // the backend refuses every write on it
  conn = c;
  activeServer = s; launcherOpen = false;
  collapsed.delete("s:" + s.id); collapsed.delete("d:" + c.id);
  renderObjects();
  refreshDatabase(c);
  // Query tabs left open last time come back (not when the same database is already open in another workspace).
  const drafts = s.conns.some((x) => x !== c && x.db === db) ? [] : loadDrafts(draftKey(c));
  if (drafts.length) {
    for (const d of drafts) openQueryTab(c, d.sql, d.title, d.id);
    toast(`Restored ${drafts.length} query tab${drafts.length === 1 ? "" : "s"}`, "info");
  } else if (s.conns.length === 1) makeTab("query", "Query", undefined, c); // first database of this connection
  else switchWorkspace(c); // every further database opens as its own workspace
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

/** Choose a database on a server and open it as its own workspace (also one that is already open: a second, independent workspace). */
async function pickAndOpen(s: Server) {
  if (!s.dbs.length) return;
  const chosen = await pickDatabase(s.dbs, null, new Set(s.conns.map((c) => c.db ?? "")));
  if (chosen) openDatabaseOn(s, chosen, s.conns.some((c) => c.db === chosen));
}

/** `again` opens a further, independent workspace on a database that is already open. */
async function openDatabaseOn(s: Server, db: string, again = false) {
  const have = s.conns.find((c) => c.db === db);
  if (have && !again) { collapsed.delete("d:" + have.id); switchWorkspace(have); return; }
  try {
    const id = await api.openDatabase(s.rootId, db);
    await addDatabase(s, id, db);
  } catch (e) { toast(`Couldn't open ${db}: ${e}`, "error"); }
}

// ---------- administration: new / drop database, truncate ----------
/** Connections can be protected (the default for production): truncate and drop are refused outright. */
const safetyOf = (s: Server) => safetyLevel(s.profile);
const isProtected = (s: Server) => safetyOf(s) !== "off";
function blocked(s: Server, what: string): boolean {
  if (!isProtected(s)) return false;
  toast(`${s.name} is protected: ${what} is blocked. Change “Safety” in the connection settings to allow it.`, "error");
  return true;
}

/** A short-lived connection to a maintenance database, for statements that can't run from inside the database they touch. */
async function withMaintenance<T>(s: Server, f: (id: number) => Promise<T>): Promise<T> {
  if (s.kind === "mysql" || s.kind === "mariadb") return f(s.rootId);
  const id = await api.openDatabase(s.rootId, s.kind === "mssql" ? "master" : "postgres");
  try { return await f(id); } finally { api.disconnect(id).catch(() => {}); }
}

async function createDatabase(s: Server) {
  const name = await promptName("New database", `On ${s.name}`, "Create");
  if (!name) return;
  const sql = createDatabaseSql(s.kind, name);
  if (!sql) { toast("This engine can't create databases here.", "info"); return; }
  try {
    s.dbs = await withMaintenance(s, async (id) => { await api.runStatements(id, [sql]); return api.listDatabases(id); });
    toast(`Created ${name}`, "ok");
    await openDatabaseOn(s, name);
  } catch (e) { toast(`Couldn't create ${name}: ${e}`, "error"); }
}

async function dropDatabase(s: Server, db: string) {
  if (blocked(s, "dropping a database")) return;
  const prod = s.env === "production";
  const ok = await confirmDanger({
    title: `Drop database ${db}?`,
    body: `This permanently deletes <b>${esc(db)}</b> and everything in it on <b>${esc(s.name)}</b>${prod ? " — a <b>production</b> connection" : ""}. It cannot be undone.`,
    confirmLabel: "Drop database", typed: db, sql: dropDatabaseSql(s.kind, db),
  });
  if (!ok) return;
  for (const c of s.conns.filter((x) => x.db === db)) closeDatabase(c); // every workspace on it, so nothing holds it open
  try {
    s.dbs = await withMaintenance(s, async (id) => {
      try { await api.runStatements(id, dropDatabaseSql(s.kind, db)); }
      catch (e) { if (s.kind !== "postgres") throw e; await api.runStatements(id, dropDatabaseSql(s.kind, db, false)); } // WITH (FORCE) needs PostgreSQL 13
      return api.listDatabases(id);
    });
    toast(`Dropped ${db}`, "ok");
  } catch (e) { toast(`Couldn't drop ${db}: ${e}`, "error"); }
  renderObjects();
  if (!s.conns.length) switchServer(s);
}

async function truncateDatabase(c: Conn) {
  if (blocked(c.server, "truncating tables")) return;
  const tables = c.objects.filter((o) => o.kind === "table");
  const sqls = truncateAllSql(c.kind, tables);
  if (!sqls) { toast("Truncating every table isn't supported for this engine.", "info"); return; }
  if (!sqls.length) { toast("There are no tables to truncate.", "info"); return; }
  const ok = await confirmDanger({
    title: `Truncate all tables in ${c.db ?? c.name}?`,
    body: `Deletes <b>every row</b> of ${tables.length} table${tables.length === 1 ? "" : "s"} in <b>${esc(c.db ?? c.name)}</b> (views are untouched). The tables themselves stay. It cannot be undone.`,
    confirmLabel: "Truncate all", typed: c.db ?? c.name, sql: sqls.length > 6 ? [...sqls.slice(0, 5), `… ${sqls.length - 5} more`] : sqls,
  });
  if (!ok) return;
  try {
    await api.runStatements(c.id, sqls);
    for (const q of sqls) logSql(c, q, 0);
    toast(`Truncated ${tables.length} table${tables.length === 1 ? "" : "s"}`, "ok");
    reloadTablesOf(c);
  } catch (e) { toast(`Truncate failed: ${e}`, "error"); }
}

/**
 * Truncate/drop one table. Foreign keys can block it, so the dialog has a phpMyAdmin-style checkbox, and if the
 * server refuses anyway the user is offered a retry that ignores foreign keys.
 */
async function tableOp(c: Conn, hasTables: boolean, op: "truncate" | "drop", build: (ignoreFk: boolean) => string[], text: { title: string; body: string; confirmLabel: string; typed?: string }, bulk = false): Promise<boolean> {
  const option = canIgnoreForeignKeys(c.kind) && hasTables ? { label: ignoreFkLabel(c.kind, op), checked: false } : undefined;
  if (!(await confirmDanger({ ...text, sql: build(false), option }))) return false;
  let ignore = !!option?.checked;
  for (;;) {
    const sqls = build(ignore);
    try { await api.runStatements(c.id, sqls); for (const q of sqls) logSql(c, q, 0); return true; }
    catch (e) {
      const msg = String(e);
      if (ignore || !option || !isForeignKeyError(msg)) { toast(`${op === "drop" ? "Drop" : "Truncate"} failed: ${msg}${bulk ? " Some tables may already have been changed." : ""}`, "error"); return false; }
      const retry = await confirmDanger({ title: "Blocked by a foreign key", body: `${esc(msg.split("\n")[0])}<br><br>Retry with foreign key constraints ignored for this operation only?`, confirmLabel: "Retry ignoring foreign keys", sql: build(true) });
      if (!retry) return false;
      ignore = true;
    }
  }
}

async function truncateTable(c: Conn, o: ObjectRef) {
  if (blocked(c.server, "truncating a table")) return;
  const done = await tableOp(c, o.kind !== "view", "truncate", (fk) => truncateTableSql(c.kind, o, fk), {
    title: `Truncate ${o.name}?`, body: `Deletes every row of <b>${esc(o.name)}</b>. The table stays. It cannot be undone.`, confirmLabel: "Truncate", typed: c.env === "production" ? o.name : undefined,
  });
  if (done) { toast(`Truncated ${o.name}`, "ok"); reloadTablesOf(c); }
}

async function dropTable(c: Conn, o: ObjectRef) {
  if (blocked(c.server, "dropping a table")) return;
  const done = await tableOp(c, o.kind !== "view", "drop", (fk) => dropTableSql(c.kind, o, fk), {
    title: `Drop ${o.kind === "view" ? "view" : "table"} ${o.name}?`, body: `Permanently removes <b>${esc(o.name)}</b>${o.kind === "view" ? "" : " and its data"}. It cannot be undone.`, confirmLabel: "Drop", typed: o.name,
  });
  if (!done) return;
  for (const t of [...tabs]) if (t.conn === c && t.table === o.name) closeTab(t);
  toast(`Dropped ${o.name}`, "ok");
  await refreshDatabase(c);
}

const nameList = (l: ObjectRef[]) => `<ul class="mt-1 mono text-[12.5px]">${l.slice(0, 8).map((o) => `<li>${esc(o.name)}</li>`).join("")}${l.length > 8 ? `<li class="text-muted">… and ${l.length - 8} more</li>` : ""}</ul>`;

function bulkMenu(c: Conn, picked: ObjectRef[], x: number, y: number) {
  const n = picked.length, nonSql = ["redis", "mongo"].includes(c.kind), tables = picked.filter((o) => o.kind !== "view");
  const prot = isProtected(c.server) ? " (protected)" : "";
  contextMenu(x, y, [
    { label: `Export ${n} tables…`, disabled: nonSql, action: () => exportTables(c, picked) },
    { divider: true, label: "" },
    { label: `Clear selection`, action: () => { clearSelection(); renderObjects(); } },
    { divider: true, label: "" },
    { label: `Truncate ${tables.length} table${tables.length === 1 ? "" : "s"}…${prot}`, danger: true, disabled: nonSql || !tables.length, action: () => truncateTables(c, tables) },
    { label: `Drop ${n} tables…${prot}`, danger: true, disabled: nonSql, action: () => dropTables(c, picked) },
  ]);
}

async function exportTables(c: Conn, objs: ObjectRef[]) {
  try {
    const many = await Promise.all(objs.map(async (o) => ({ name: o.name, sql: await api.selectAllSql(c.id, o.schema, o.name, 2_000_000_000) })));
    conn = c;
    showExport(c.id, "", `${many.length} tables`, (m) => toast(m, m.startsWith("Exported") && !m.includes("Failed") ? "ok" : "info"), many);
  } catch (e) { toast(`Couldn't prepare the export: ${e}`, "error"); }
}

async function truncateTables(c: Conn, tables: ObjectRef[]) {
  if (blocked(c.server, "truncating tables")) return;
  const done = await tableOp(c, true, "truncate", (fk) => truncateTablesSql(c.kind, tables, fk), {
    title: `Truncate ${tables.length} tables?`, body: `Deletes every row of these tables. The tables stay. It cannot be undone.${nameList(tables)}`,
    confirmLabel: "Truncate", typed: c.env === "production" ? c.db ?? c.name : undefined,
  }, true);
  if (!done) return;
  toast(`Truncated ${tables.length} tables`, "ok");
  reloadTablesOf(c);
}

async function dropTables(c: Conn, objs: ObjectRef[]) {
  if (blocked(c.server, "dropping tables")) return;
  const done = await tableOp(c, objs.some((o) => o.kind !== "view"), "drop", (fk) => dropTablesSql(c.kind, objs, fk), {
    title: `Drop ${objs.length} tables?`, body: `Permanently removes these tables and their data. It cannot be undone.${nameList(objs)}`,
    confirmLabel: "Drop", typed: c.db ?? c.name,
  }, true);
  if (!done) return;
  const gone = new Set(objs.map((o) => o.name));
  for (const t of [...tabs]) if (t.conn === c && t.table && gone.has(t.table)) closeTab(t);
  clearSelection();
  toast(`Dropped ${objs.length} tables`, "ok");
  await refreshDatabase(c);
}

/** Re-read the open table tabs of a database after its rows were deleted. */
function reloadTablesOf(c: Conn) {
  for (const t of tabs) if (t.kind === "table" && t.conn === c && !t.grid.pendingCount) reload(t);
}

function closeDatabase(c: Conn) {
  for (const t of [...tabs]) if (t.conn === c) closeTab(t, true);
  // The server's root connection also keeps its SSH tunnel alive, so it stays until the server is disconnected.
  if (c.id !== c.server.rootId) api.disconnect(c.id).catch(() => {});
  c.server.conns = c.server.conns.filter((x) => x !== c);
  if (conn === c) {
    const next = c.server.conns[c.server.conns.length - 1] ?? servers.flatMap((x) => x.conns)[0] ?? null;
    if (next) switchWorkspace(next); else { conn = null; renderObjects(); }
    return;
  }
  renderObjects();
  afterWorkspaceChange();
}

function disconnectServer(s: Server) {
  for (const c of [...s.conns]) { for (const t of [...tabs]) if (t.conn === c) closeTab(t, true); if (c.id !== s.rootId) api.disconnect(c.id).catch(() => {}); }
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
    b(`${icon("play", 13)}<span>Run</span><span class="kbd" style="color:inherit;border-color:rgb(255 255 255 / .4);background:transparent">⌘↵</span>`, "Run the selection or the statement under the cursor (⌘Enter). ⌘⇧Enter runs every statement.", () => { activate(tab); runActive(); }, "btn btn-primary"),
    b(`${icon("stop", 13)}<span>Stop</span>`, "Cancel the running query (⌘.)", () => { activate(tab); cancelActive(); }),
    sep(),
    b(`${icon("plan", 14)}<span>Explain</span>`, "Show the query plan and suggestions (⌘E)", () => { activate(tab); explainActive(false); }),
    b(`${icon("star", 14)}<span>Favorite</span>`, "Add this query to your favorites (⌘⇧S)", () => { activate(tab); favoriteCurrentQuery(); }),
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
  const dismissed = localStorage.getItem("tabnix.tpDismissed") === "1";
  wrap.innerHTML = `<div class="mx-auto px-10 pt-12 pb-10" style="max-width:860px">
    <div class="flex items-center gap-5">
      <div class="flex-1"><div class="flex items-center gap-3.5 mb-3"><img src="/tabnix-logo.png" alt="" width="44" height="44" style="border-radius:11px;box-shadow:0 1px 2px rgb(19 34 48 / .18), 0 6px 16px rgb(11 116 160 / .25)"/><span class="text-[15px] font-semibold text-soft">Tabnix</span></div>
        <h1 class="text-[30px] font-semibold leading-[1.15] tracking-[-0.02em]">Where would you like to work?</h1>
        <p class="text-soft text-[15px] mt-1.5">Open a saved connection, or add a new one.</p></div>
      <div class="hidden md:block text-muted shrink-0">${ART_TABNIX}</div>
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
  (wrap.querySelector("#tpno") as HTMLElement | null)?.addEventListener("click", () => { localStorage.setItem("tabnix.tpDismissed", "1"); showLauncher(); });
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

let closePalette: (() => void) | null = null;
function palette() {
  closePalette?.();
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
    (list.children[idx] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { idx = Math.min(idx + 1, items.length - 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { idx = Math.max(idx - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === "Enter" && items[idx]) { e.preventDefault(); choose(items[idx]); }
    else if (document.activeElement !== inp && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) inp.focus();
  };
  const close = () => { p.classList.add("hidden"); inp.oninput = null; window.removeEventListener("keydown", onKey, true); closePalette = null; };
  closePalette = close;
  const choose = (o: ObjectRef) => { close(); openTable(o.name); };
  inp.oninput = () => { idx = 0; draw(); };
  window.addEventListener("keydown", onKey, true);
  draw();
}

/** ⌘⌥E: export the active tab's full result (not just the rows on screen) to a file. */
async function exportActive() {
  const t = active;
  if (!t?.conn) return;
  let sqlText: string;
  if (t.kind === "table" && t.table) {
    const o = t.conn.objects.find((x) => x.name === t.table);
    sqlText = await api.selectAllSql(t.conn.id, o?.schema ?? null, t.table, 2_000_000_000, t.filterWhere, buildOrder(t.sort, quoteFor(t.conn)) || undefined);
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
  if (capturing) return;
  if (document.querySelector("[data-modal]")) return; // dialogs own the keyboard (their own listeners run first)
  const k = e.key.toLowerCase();
  const inText = e.target instanceof HTMLElement && !!e.target.closest("input, textarea, .cm-editor, [contenteditable]");
  if (e.metaKey && !inText && !e.altKey && !e.shiftKey && active && active.kind !== "diagram") {
    if (k === "c" && active.grid.selectedCount > 0) { e.preventDefault(); copyRows(active, "tsv"); return; }
    if (k === "a" && active.grid.columns.length) { e.preventDefault(); active.grid.selectAll(); return; }
  }
  if (e.metaKey && !e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) { e.preventDefault(); const t = nthTab(tabs, conn, +e.code.slice(5)); if (t) activate(t); return; }
  const id = matchAction(e);
  const h = id && handlers[id];
  if (h && h(e) !== false) e.preventDefault();
});

/** What each rebindable shortcut does (ids and default keys live in settings.ts). Returning false leaves the key event alone. */
const handlers: Record<string, (e: KeyboardEvent) => unknown> = {
  newQuery, openConnections, newConnection: openConnections, palette, toggleLog, cancel: cancelActive, builder: toggleBuilder,
  settings: showSettings, theme: () => toggleTheme(), dbPicker: openDatabasePicker, export: exportActive, import: importActive, backup: backupActive, restore: restoreActive,
  closeTab: () => active && closeTab(active),
  diagram: () => openDiagram(active?.kind === "table" ? active.table : undefined),
  reload: () => active && reload(active),
  run: () => runActive(false), runAll: () => runActive(true),
  explain: () => explainActive(false), explainAnalyze: () => explainActive(true),
  focusFilter: () => $("filter").focus(),
  nextTab: () => cycle(1), prevTab: () => cycle(-1),
  favorite: () => active?.kind === "query" ? favoriteCurrentQuery() : false,
  commitAll,
  discard: () => active?.kind === "table" || (active?.kind === "query" && active.edit) ? (active.grid.pendingCount ? discardChanges(active) : false) : false,
  commit: () => active?.kind === "table" || (active?.kind === "query" && active.edit) ? commitChanges(active) : false,
  addRow: () => active?.kind === "table" ? active.grid.addRow() : false,
  deleteRow: (e) => active?.kind === "table" && !(e.target instanceof HTMLInputElement) ? deleteRow(active) : false,
  filterTable: () => { if (active?.kind !== "table" || !active.filterBar) return false; if (active.mode === "structure") setMode(active, "data"); active.filterBar.toggle(); },
};

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

$("sqllog-btn").onclick = toggleLog;
$("more").onclick = () => {
  const r = $("more").getBoundingClientRect(), can = !!conn && BACKUP_KINDS.includes(conn.kind);
  contextMenu(r.left, r.bottom + 4, [
    { label: "Back up…", hint: prettyCombo(comboOf("backup")), disabled: !can, action: backupActive },
    { label: "Restore…", hint: prettyCombo(comboOf("restore")), disabled: !can, action: restoreActive },
    { divider: true, label: "" },
    { label: "Import a file…", hint: prettyCombo(comboOf("import")), disabled: !conn, action: importActive },
  ]);
};
$("export").onclick = exportActive;
$("newtab").onclick = newQuery;
$("open").onclick = openConnections;
$("addconn").onclick = () => showLauncher();
$("diagram").onclick = () => openDiagram();
const paintTheme = () => { $("theme").innerHTML = icon(currentTheme() === "dark" ? "sun" : "moon", 15); };
const toggleTheme = () => { applyTheme(currentTheme() === "dark" ? "light" : "dark"); applyAppearance(); paintTheme(); };
$("theme").onclick = toggleTheme;
$("settings").onclick = showSettings;
paintTheme();
renderObjects();
showLauncher();
$("filter").oninput = renderObjects;
renderSideTabs();

// Memory profiling (scripts/memprofile.sh): this branch is removed from builds without VITE_PROFILE.
if (import.meta.env.VITE_PROFILE) {
  import("./profile").then((m) => m.install({ useConnection, exec, openTable: (n) => openTable(n), closeTab, activate, tabs, conn: () => conn }));
}
