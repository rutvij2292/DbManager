import { show } from "./api";
import type { Grid } from "./grid";
import { makeMatcher, type FindOptions } from "./findreplace";
import { icon } from "./icons";
import { esc, toast } from "./ui";

const FIND_CAP = 100_000;     // highlighted matches kept in memory
const REPLACE_CAP = 10_000;   // cells staged by one Replace all (each becomes an UPDATE on commit)

/**
 * Find & Replace over the whole result (every page, read from Rust one at a time), with highlighting and stepping.
 * Replacements are staged like any other edit: nothing is written until Commit, and Discard undoes them.
 */
export function createGridFind(grid: Grid, onClose?: () => void) {
  const el = document.createElement("div");
  el.className = "shrink-0 border-b border-line bg-canvas px-3 py-2 text-[13px]";
  el.style.display = "none";
  const opts: FindOptions = { caseSensitive: false, wholeCell: false, regex: false };
  let query = "", repl = "", col = -1, seq = 0, timer = 0, sig = "", busy = false, rid = -2;

  el.innerHTML = `
    <div class="flex items-center gap-1.5" data-r1>
      <span class="text-soft">${icon("search", 14)}</span>
      <input class="field field-sm" data-q placeholder="Find in all rows" style="width:230px" spellcheck="false" autocomplete="off">
      <span class="seg" data-opts></span>
      <select class="field field-sm" data-col style="width:150px" title="Search one column or all"></select>
      <button class="btn btn-ghost btn-sm" data-prev title="Previous match (⇧↵)" style="width:28px;padding:0;justify-content:center">↑</button>
      <button class="btn btn-ghost btn-sm" data-next title="Next match (↵)" style="width:28px;padding:0;justify-content:center">↓</button>
      <span class="text-muted min-w-0 truncate" data-count></span>
      <span class="flex-1"></span>
      <button class="btn btn-ghost btn-sm" data-x aria-label="Close" title="Close (Esc)">${icon("close", 14)}</button>
    </div>
    <div class="flex items-center gap-1.5 mt-1.5" data-r2>
      <span class="text-soft" style="width:14px"></span>
      <input class="field field-sm" data-rep placeholder="Replace with" style="width:230px" spellcheck="false" autocomplete="off">
      <button class="btn btn-sm" data-one>Replace</button>
      <button class="btn btn-sm" data-all>Replace all</button>
      <span class="text-muted" data-hint></span>
    </div>`;
  const $ = <T extends HTMLElement>(s: string) => el.querySelector(s) as T;
  const q = $<HTMLInputElement>("[data-q]"), rep = $<HTMLInputElement>("[data-rep]"), colSel = $<HTMLSelectElement>("[data-col]");
  const count = $("[data-count]"), r2 = $("[data-r2]"), oneBtn = $<HTMLButtonElement>("[data-one]"), allBtn = $<HTMLButtonElement>("[data-all]");

  const optBtns: [keyof FindOptions, string, string][] = [["caseSensitive", "Aa", "Match case"], ["wholeCell", "Cell", "Match the whole cell"], ["regex", ".*", "Regular expression"]];
  for (const [k, label, title] of optBtns) {
    const b = document.createElement("button");
    b.textContent = label; b.title = title; b.setAttribute("aria-pressed", "false");
    b.onclick = () => { opts[k] = !opts[k]; b.setAttribute("aria-pressed", String(opts[k])); search(); };
    $("[data-opts]").append(b);
  }

  const say = (t: string, bad = false) => { count.textContent = t; count.classList.toggle("text-danger", bad); };

  function syncShape() {
    const names = grid.columns.map((c) => c.name), s = names.join("\u0000");
    if (s !== sig) {
      sig = s; col = -1;
      colSel.innerHTML = `<option value="-1">All columns</option>` + names.map((n, i) => `<option value="${i}">${esc(n)}</option>`).join("");
      colSel.value = "-1";
    }
    const can = grid.editable;
    r2.style.display = can ? "" : "none";
  }
  colSel.onchange = () => { col = +colSel.value; search(); };

  async function search(keepAfter = false) {
    clearTimeout(timer);
    const my = ++seq;
    if (!query) { grid.setMatches(null); say(""); return; }
    const m = makeMatcher(query, opts);
    if (m.error) { grid.setMatches(null); say(m.error, true); return; }
    say("Searching…");
    const r = await grid.findCells((t) => m.test(t), col < 0 ? null : col, FIND_CAP, () => my !== seq,
      (done, total) => { if (my === seq && total > 2000) say(`Searching… ${Math.round((done / total) * 100)}%`); });
    if (my !== seq || r.aborted) return;
    grid.setMatches(r.cells);
    if (!r.cells.length) { say("No matches"); return; }
    grid.startMatches(keepAfter);
    update(r.capped);
  }
  function update(capped = false) {
    const n = grid.matchCount;
    say(n ? `${grid.matchIndex + 1} of ${n.toLocaleString()}${capped ? "+" : ""}` : "No matches");
    oneBtn.disabled = allBtn.disabled = !n || busy;
  }
  const step = (d: number) => { if (grid.matchCount) { grid.stepMatch(d); update(grid.matchCount >= FIND_CAP); } };

  async function replace(all: boolean) {
    if (busy || !grid.matchCount) return;
    const m = makeMatcher(query, opts);
    const a = grid.activeCell;
    let cells: [number, number][] = [];
    if (all) cells = grid.allMatches();
    else if (a && grid.isMatch(a.r, a.c)) cells = [[a.r, a.c]];
    else { step(1); return; }
    const editable = cells.filter(([, c]) => grid.canEditCell(c));
    const skipped = cells.length - editable.length;
    const use = editable.slice(0, REPLACE_CAP);
    if (!use.length) { toast("These columns can't be edited here", "info"); return; }
    busy = true; oneBtn.disabled = allBtn.disabled = true; say("Replacing…");
    try {
      const rows = [...new Set(use.map(([r]) => r))];
      const vals = new Map<number, Awaited<ReturnType<Grid["rowValues"]>>[number]>();
      const got = await grid.rowValues(rows);
      rows.forEach((r, i) => vals.set(r, got[i]));
      const items = use.flatMap(([r, c]): [number, number, { t: "Text"; v: string }][] => {
        const v = vals.get(r)?.[c];
        return v && v.t !== "Null" && v.t !== "Bytes" ? [[r, c, { t: "Text", v: m.replace(show(v), repl) }]] : [];
      });
      const n = await grid.stageMany(items);
      toast(`${n.toLocaleString()} cell${n === 1 ? "" : "s"} changed${editable.length > use.length ? ` (first ${REPLACE_CAP.toLocaleString()} — run Replace all again for the rest)` : ""}${skipped ? ` · ${skipped.toLocaleString()} in read-only columns skipped` : ""}. Commit to save.`, "ok");
    } finally { busy = false; }
    await search(!all);
  }

  q.oninput = () => { query = q.value; clearTimeout(timer); timer = window.setTimeout(() => search(), 180); };
  rep.oninput = () => { repl = rep.value; };
  q.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (timer) { clearTimeout(timer); timer = 0; search(); } else step(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  };
  rep.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); replace(e.metaKey || e.altKey); } else if (e.key === "Escape") { e.preventDefault(); close(); } };
  $("[data-next]").onclick = () => step(1);
  $("[data-prev]").onclick = () => step(-1);
  $("[data-x]").onclick = () => close();
  oneBtn.onclick = () => replace(false);
  allBtn.onclick = () => replace(true);
  oneBtn.title = "Replace this match and go to the next"; allBtn.title = "Replace every match (staged, not saved until Commit)";
  $("[data-hint]").textContent = "Staged like any edit — Commit to save, Discard to undo";

  // Rows or columns changed under us (a new result, a commit): follow along.
  const prev = grid.onActive;
  grid.onActive = () => {
    prev();
    if (el.style.display === "none") return;
    const before = sig, was = rid;
    syncShape();
    rid = grid.resultId;
    if ((sig !== before || rid !== was) && query) search();
  };

  function open() {
    el.style.display = "";
    syncShape(); rid = grid.resultId;
    q.focus(); q.select();
    if (query) search();
  }
  function close() {
    el.style.display = "none"; seq++; grid.setMatches(null);
    onClose?.();
  }
  return { el, open, close, get isOpen() { return el.style.display !== "none"; }, toggle() { this.isOpen ? close() : open(); } };
}
