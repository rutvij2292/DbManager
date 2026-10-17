import { type ColumnInfo, type IndexInfo, type ObjectInfo, type StructChange } from "./api";
import { icon } from "./icons";

const cell = "struct-cell bg-transparent border border-transparent hover:border-line-strong focus:border-accent focus:bg-panel rounded-md px-2 h-7 outline-none w-full mono";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

interface Row { orig: ColumnInfo | null; name: string; type: string; nullable: boolean; def: string; dropped: boolean }

/** Pure diff from the edited rows to the staged structure changes (exported for tests). */
export function diffColumns(rows: Row[]): StructChange[] {
  const out: StructChange[] = [];
  for (const r of rows) {
    if (!r.orig) {
      if (!r.dropped && r.name.trim()) out.push({ kind: "add_column", name: r.name.trim(), type_name: r.type.trim() || "TEXT", nullable: r.nullable, default: r.def.trim() || null });
      continue;
    }
    if (r.dropped) { out.push({ kind: "drop_column", name: r.orig.name }); continue; }
    if (r.name.trim() && r.name.trim() !== r.orig.name) out.push({ kind: "rename_column", from: r.orig.name, to: r.name.trim() });
    const oldDef = r.orig.default ?? "";
    if (r.type.trim() !== r.orig.type_name || r.nullable !== r.orig.nullable || r.def.trim() !== oldDef.trim()) {
      out.push({ kind: "alter_column", name: r.name.trim() || r.orig.name, type_name: r.type.trim(), nullable: r.nullable, default: r.def.trim() || null, old_type: r.orig.type_name, old_nullable: r.orig.nullable, old_default: r.orig.default });
    }
  }
  return out;
}

/**
 * Structure editor: columns (rename / retype / nullability / default / add / drop), indexes
 * (create / drop) and foreign keys (read-only). Edits are staged; `commit` shows the generated DDL.
 */
export function createStructureView(
  load: () => Promise<ObjectInfo>,
  commit: (changes: StructChange[]) => Promise<boolean>,
  status: (s: string) => void,
): { el: HTMLElement; reload: () => Promise<void> } {
  const el = document.createElement("div");
  el.className = "h-full overflow-auto px-6 py-5 text-[13px] bg-panel";
  let rows: Row[] = [];
  let indexes: IndexInfo[] = [];
  let droppedIdx = new Set<string>();
  let newIdx: { name: string; columns: string; unique: boolean }[] = [];
  let info: ObjectInfo | null = null;

  const pending = (): StructChange[] => [
    ...diffColumns(rows),
    ...[...droppedIdx].map((name): StructChange => ({ kind: "drop_index", name })),
    ...newIdx.filter((i) => i.name.trim() && i.columns.trim()).map((i): StructChange => ({ kind: "create_index", name: i.name.trim(), columns: i.columns.split(",").map((c) => c.trim()).filter(Boolean), unique: i.unique })),
  ];

  async function reload() {
    info = await load();
    rows = info.columns.map((c) => ({ orig: c, name: c.name, type: c.type_name, nullable: c.nullable, def: c.default ?? "", dropped: false }));
    indexes = info.index_details;
    droppedIdx = new Set();
    newIdx = [];
    draw();
  }

  function draw() {
    const n = pending().length;
    const box = (title: string, count: number, body: string) => `<section class="rounded-xl border border-line-strong overflow-hidden mb-4">
        <div class="flex items-center gap-2 px-4 h-8 bg-canvas border-b border-line"><span class="font-medium">${title}</span><span class="pill">${count}</span></div>${body}</section>`;
    const th = "text-left font-medium text-soft px-2 h-8";
    el.innerHTML = `
      <div class="flex items-center gap-2 mb-5">
        <button id="addcol" class="btn">${icon("plus", 14)}<span>Column</span></button>
        <button id="addidx" class="btn">${icon("plus", 14)}<span>Index</span></button>
        <span class="w-px h-4 bg-line-strong mx-1"></span>
        <button id="commit" class="btn btn-primary" ${n ? "" : "disabled"}>Review &amp; commit${n ? ` (${n})` : ""}</button>
        <button id="discard" class="btn" ${n ? "" : "disabled"}>Discard</button>
        <span class="text-muted ml-2">Changes are staged. You review the generated SQL before anything runs.</span>
      </div>
      ${box("Columns", rows.filter((r) => !r.dropped).length, `<table class="w-full"><thead><tr class="border-b border-line"><th class="w-9"></th><th class="${th}">Name</th><th class="${th}">Type</th><th class="${th} w-24">Nullable</th><th class="${th}">Default</th><th class="w-9"></th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="border-b border-line last:border-b-0 ${r.dropped ? "opacity-40 line-through" : ""} ${!r.orig ? "bg-ok-soft" : ""}">
        <td class="pl-3 text-warn">${r.orig?.primary_key ? icon("key", 14) : ""}</td>
        <td class="px-1 py-0.5"><input data-r="${i}" data-f="name" class="${cell}" value="${esc(r.name)}"/></td>
        <td class="px-1"><input data-r="${i}" data-f="type" class="${cell}" value="${esc(r.type)}"/></td>
        <td class="px-3"><input type="checkbox" data-r="${i}" data-f="nullable" ${r.nullable ? "checked" : ""}/></td>
        <td class="px-1"><input data-r="${i}" data-f="def" class="${cell}" value="${esc(r.def)}" placeholder="none"/></td>
        <td class="pr-2"><button data-drop="${i}" class="btn btn-ghost" style="width:24px;padding:0;justify-content:center" title="${r.dropped ? "Undo drop" : "Drop column"}">${r.dropped ? icon("undo", 13) : icon("close", 12)}</button></td></tr>`).join("")}
      </tbody></table>`)}
      ${box("Indexes", indexes.length + newIdx.length, `<table class="w-full"><tbody>
      ${indexes.map((ix) => `<tr class="border-b border-line last:border-b-0 ${droppedIdx.has(ix.name) ? "opacity-40 line-through" : ""}"><td class="px-4 h-9 mono">${esc(ix.name)}</td><td class="px-2 mono text-soft">${esc(ix.columns.join(", "))}</td>
        <td class="px-2">${ix.primary ? '<span class="pill">primary</span>' : ix.unique ? '<span class="pill">unique</span>' : ""}</td>
        <td class="pr-2 w-9">${ix.primary ? "" : `<button data-dropidx="${esc(ix.name)}" class="btn btn-ghost" style="width:24px;padding:0;justify-content:center">${droppedIdx.has(ix.name) ? icon("undo", 13) : icon("close", 12)}</button>`}</td></tr>`).join("")}
      ${newIdx.map((ix, i) => `<tr class="border-b border-line last:border-b-0 bg-ok-soft"><td class="px-2 py-0.5"><input data-ni="${i}" data-f="name" class="${cell}" placeholder="index_name" value="${esc(ix.name)}"/></td>
        <td class="px-1"><input data-ni="${i}" data-f="columns" class="${cell}" placeholder="col1, col2" value="${esc(ix.columns)}"/></td>
        <td class="px-2"><label class="flex items-center gap-1.5"><input type="checkbox" data-ni="${i}" data-f="unique" ${ix.unique ? "checked" : ""}/> unique</label></td>
        <td class="pr-2 w-9"><button data-rmni="${i}" class="btn btn-ghost" style="width:24px;padding:0;justify-content:center">${icon("close", 12)}</button></td></tr>`).join("")}
      </tbody></table>`)}
      ${info && info.foreign_keys.length ? box("Foreign keys", info.foreign_keys.length, `<table class="w-full"><tbody>${info.foreign_keys.map((f) => `<tr class="border-b border-line last:border-b-0"><td class="px-4 h-9 mono">${esc(f.name)}</td><td class="px-2 mono text-soft">${esc(f.columns.join(", "))} <span class="text-muted">references</span> ${esc((f.ref_schema && f.ref_schema !== "public" ? f.ref_schema + "." : "") + f.ref_table)}(${esc(f.ref_columns.join(", "))})</td></tr>`).join("")}</tbody></table>`) : ""}
      ${info?.ddl ? box("Definition", 1, `<pre class="mono text-[13px] p-4 overflow-auto select-text whitespace-pre-wrap">${esc(info.ddl)}</pre>`) : ""}`;

    const q = <T extends HTMLElement>(s: string) => el.querySelector(s) as T;
    q("#addcol").onclick = () => { rows.push({ orig: null, name: "", type: "TEXT", nullable: true, def: "", dropped: false }); draw(); };
    q("#addidx").onclick = () => { newIdx.push({ name: "", columns: "", unique: false }); draw(); };
    q("#discard").onclick = () => { reload(); };
    q("#commit").onclick = async () => {
      try {
        if (await commit(pending())) { await reload(); status("Structure updated"); }
      } catch (e) { status("Structure change failed: " + e); }
    };
    el.querySelectorAll<HTMLInputElement>("[data-r]").forEach((inp) => {
      inp.onchange = inp.oninput = () => {
        const r = rows[+inp.dataset.r!], f = inp.dataset.f!;
        if (f === "nullable") r.nullable = inp.checked; else (r as unknown as Record<string, string>)[f] = inp.value;
        refreshButtons();
      };
    });
    el.querySelectorAll<HTMLInputElement>("[data-ni]").forEach((inp) => {
      inp.onchange = inp.oninput = () => {
        const r = newIdx[+inp.dataset.ni!], f = inp.dataset.f!;
        if (f === "unique") r.unique = inp.checked; else (r as unknown as Record<string, string>)[f] = inp.value;
        refreshButtons();
      };
    });
    el.querySelectorAll<HTMLElement>("[data-drop]").forEach((b) => (b.onclick = () => {
      const r = rows[+b.dataset.drop!];
      if (!r.orig) rows.splice(+b.dataset.drop!, 1); else r.dropped = !r.dropped;
      draw();
    }));
    el.querySelectorAll<HTMLElement>("[data-dropidx]").forEach((b) => (b.onclick = () => {
      const n = b.dataset.dropidx!;
      droppedIdx.has(n) ? droppedIdx.delete(n) : droppedIdx.add(n);
      draw();
    }));
    el.querySelectorAll<HTMLElement>("[data-rmni]").forEach((b) => (b.onclick = () => { newIdx.splice(+b.dataset.rmni!, 1); draw(); }));
  }

  // Update the commit/discard buttons without rebuilding the DOM (keeps input focus while typing).
  function refreshButtons() {
    const n = pending().length;
    const c = el.querySelector("#commit") as HTMLButtonElement, d = el.querySelector("#discard") as HTMLButtonElement;
    c.disabled = d.disabled = !n;
    c.innerHTML = "Review &amp; commit" + (n ? ` (${n})` : "");
  }

  return { el, reload };
}
