import { api, type ColumnInfo, type IndexInfo, type ObjectInfo, type StructChange } from "./api";

const cell = "bg-transparent border border-transparent hover:border-zinc-700 focus:border-blue-600 rounded px-1 py-0.5 outline-none w-full mono";
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
  el.className = "h-full overflow-auto p-3 text-[12px] bg-zinc-900";
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
    el.innerHTML = `
      <div class="flex items-center gap-2 mb-2">
        <button id="addcol" class="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700">+ Column</button>
        <button id="addidx" class="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700">+ Index</button>
        <button id="commit" class="px-2 py-0.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40" ${n ? "" : "disabled"}>Review &amp; commit${n ? ` (${n})` : ""}</button>
        <button id="discard" class="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40" ${n ? "" : "disabled"}>Discard</button>
        <span class="text-zinc-500 ml-2">Edit a cell, then review the generated DDL before it runs.</span>
      </div>
      <table class="w-full mb-4"><thead class="text-zinc-400 text-left"><tr><th class="px-1 w-8"></th><th class="px-1">Column</th><th class="px-1">Type</th><th class="px-1 w-20">Nullable</th><th class="px-1">Default</th><th class="w-8"></th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="border-t border-zinc-800 ${r.dropped ? "opacity-40 line-through" : ""} ${!r.orig ? "bg-green-950/30" : ""}">
        <td class="px-1 text-zinc-500">${r.orig?.primary_key ? "🔑" : ""}</td>
        <td><input data-r="${i}" data-f="name" class="${cell}" value="${esc(r.name)}"/></td>
        <td><input data-r="${i}" data-f="type" class="${cell}" value="${esc(r.type)}"/></td>
        <td class="px-1"><input type="checkbox" data-r="${i}" data-f="nullable" ${r.nullable ? "checked" : ""}/></td>
        <td><input data-r="${i}" data-f="def" class="${cell}" value="${esc(r.def)}" placeholder="—"/></td>
        <td><button data-drop="${i}" class="text-zinc-500 hover:text-red-400" title="${r.dropped ? "Undo drop" : "Drop column"}">${r.dropped ? "↺" : "×"}</button></td></tr>`).join("")}
      </tbody></table>
      <div class="text-zinc-400 mb-1">Indexes</div>
      <table class="w-full mb-4"><tbody>
      ${indexes.map((ix) => `<tr class="border-t border-zinc-800 ${droppedIdx.has(ix.name) ? "opacity-40 line-through" : ""}"><td class="px-1 mono">${esc(ix.name)}</td><td class="px-1 mono text-zinc-400">${esc(ix.columns.join(", "))}</td>
        <td class="px-1 text-zinc-500">${ix.primary ? "primary" : ix.unique ? "unique" : ""}</td>
        <td class="w-8">${ix.primary ? "" : `<button data-dropidx="${esc(ix.name)}" class="text-zinc-500 hover:text-red-400">${droppedIdx.has(ix.name) ? "↺" : "×"}</button>`}</td></tr>`).join("")}
      ${newIdx.map((ix, i) => `<tr class="border-t border-zinc-800 bg-green-950/30"><td><input data-ni="${i}" data-f="name" class="${cell}" placeholder="index_name" value="${esc(ix.name)}"/></td>
        <td><input data-ni="${i}" data-f="columns" class="${cell}" placeholder="col1, col2" value="${esc(ix.columns)}"/></td>
        <td class="px-1"><label><input type="checkbox" data-ni="${i}" data-f="unique" ${ix.unique ? "checked" : ""}/> unique</label></td>
        <td><button data-rmni="${i}" class="text-zinc-500 hover:text-red-400">×</button></td></tr>`).join("")}
      </tbody></table>
      ${info && info.foreign_keys.length ? `<div class="text-zinc-400 mb-1">Foreign keys</div><table class="w-full"><tbody>${info.foreign_keys.map((f) => `<tr class="border-t border-zinc-800"><td class="px-1 mono">${esc(f.name)}</td><td class="px-1 mono text-zinc-400">${esc(f.columns.join(", "))} → ${esc((f.ref_schema && f.ref_schema !== "public" ? f.ref_schema + "." : "") + f.ref_table)}(${esc(f.ref_columns.join(", "))})</td></tr>`).join("")}</tbody></table>` : ""}
      ${info?.ddl ? `<div class="text-zinc-400 mt-4 mb-1">DDL</div><pre class="mono text-[11px] bg-zinc-950 rounded p-2 overflow-auto select-text whitespace-pre-wrap">${esc(info.ddl)}</pre>` : ""}`;

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
