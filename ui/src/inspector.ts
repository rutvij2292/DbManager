import { show, type Val } from "./api";
import type { Grid } from "./grid";
import { formatSize, minifyJson, prettyJson, hexDump, utf8Length, viewOf } from "./cellview";
import { icon } from "./icons";
import { esc, toast } from "./ui";

const TREE_LIMIT = 300_000; // bigger JSON stays a text view: building a tree for it would cost real memory

/** Lazy JSON tree: children of a node are only built when it is opened. */
function jsonNode(key: string | null, v: unknown, open: boolean): HTMLElement {
  const label = key === null ? "" : `<span class="v-soft">${esc(key)}</span>: `;
  if (v === null || typeof v !== "object") {
    const d = document.createElement("div");
    d.className = "mono text-[12.5px] leading-6 pl-4 break-all";
    const cls = v === null ? "v-null" : typeof v === "number" ? "v-num" : typeof v === "boolean" ? "" : "";
    const txt = typeof v === "string" ? JSON.stringify(v) : String(v);
    d.innerHTML = `${label}<span class="${cls}" style="${typeof v === "string" ? "color:var(--ok)" : ""}">${esc(txt)}</span>`;
    return d;
  }
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
  const det = document.createElement("details");
  det.className = "mono text-[12.5px]";
  const sum = document.createElement("summary");
  sum.className = "cursor-pointer leading-6 select-none";
  sum.innerHTML = `${label}<span class="text-muted">${Array.isArray(v) ? `[${entries.length}]` : `{${entries.length}}`}</span>`;
  det.append(sum);
  let built = false;
  const build = () => {
    if (built) return; built = true;
    const box = document.createElement("div");
    box.className = "pl-4 border-l border-line ml-1.5";
    const shown = entries.slice(0, 500);
    for (const [k, x] of shown) box.append(jsonNode(k, x, false));
    if (entries.length > shown.length) { const m = document.createElement("div"); m.className = "text-muted pl-4"; m.textContent = `… ${(entries.length - shown.length).toLocaleString()} more`; box.append(m); }
    det.append(box);
  };
  det.ontoggle = () => { if (det.open) build(); };
  if (open) { det.open = true; build(); }
  return det;
}

/**
 * Cell inspector: a side panel showing the active cell of a grid in full — long text, JSON (tree or text),
 * images, bytes as hex — and editing it when the grid allows. Nothing is built while it is closed.
 */
export function createInspector(grid: Grid) {
  const el = document.createElement("aside");
  el.className = "hidden shrink-0 flex flex-col min-h-0 border-l border-line bg-canvas text-[13px]";
  el.style.width = "340px";
  let open = false, raf = 0, imgUrl: string | null = null, jsonMode: "tree" | "text" = "tree", hexMode: "hex" | "text" = "hex";

  const free = () => { if (imgUrl) { URL.revokeObjectURL(imgUrl); imgUrl = null; } };

  function paint() {
    raf = 0;
    free();
    if (!open) return;
    const a = grid.activeCell, v = a ? grid.valueAt(a.r, a.c) : undefined;
    if (!a || !v) {
      el.innerHTML = `<div class="flex items-center h-10 px-3 border-b border-line"><span class="font-medium">Cell inspector</span><button class="btn btn-ghost btn-sm ml-auto" data-x aria-label="Close">${icon("close", 14)}</button></div><div class="p-4 text-muted">Select a cell to see its full value.</div>`;
      (el.querySelector("[data-x]") as HTMLElement).onclick = () => toggle(false);
      return;
    }
    const col = grid.columns[a.c], editable = grid.canEditCell(a.c) && !grid.isMarkedDeleted(a.r);
    const view = viewOf(v, show);
    const edited = !!grid.editsOf(a.r)?.has(a.c);
    let meta = "";
    if (view.kind === "null") meta = "NULL";
    else if (view.kind === "image") meta = `${view.mime.replace("image/", "").toUpperCase()} image · ${formatSize(view.bytes.length)}`;
    else if (view.kind === "bytes") meta = `Binary · ${formatSize(view.bytes.length)}`;
    else meta = `${view.text.length.toLocaleString()} characters · ${formatSize(utf8Length(view.text))}${view.kind === "json" ? " · JSON" : ""}`;
    el.innerHTML = `
      <div class="flex items-center h-10 px-3 border-b border-line gap-2 shrink-0">
        <span class="font-medium truncate" data-title></span>
        <span class="pill shrink-0" data-type></span>
        <button class="btn btn-ghost btn-sm ml-auto" data-x aria-label="Close" title="Close">${icon("close", 14)}</button>
      </div>
      <div class="px-3 py-1.5 text-muted text-[12px] flex items-center gap-2 shrink-0"><span data-meta></span>${edited ? '<span class="pill" style="color:var(--warn)">edited</span>' : ""}<span class="flex-1"></span><span data-modes class="seg"></span></div>
      <div class="flex-1 min-h-0 flex flex-col px-3 pb-2" data-body></div>
      <div class="flex items-center gap-1.5 px-3 py-2 border-t border-line shrink-0" data-foot></div>`;
    (el.querySelector("[data-title]") as HTMLElement).textContent = col?.name ?? "";
    (el.querySelector("[data-type]") as HTMLElement).textContent = col?.type_name ?? "";
    (el.querySelector("[data-meta]") as HTMLElement).textContent = meta;
    (el.querySelector("[data-x]") as HTMLElement).onclick = () => toggle(false);
    const body = el.querySelector("[data-body]") as HTMLElement, foot = el.querySelector("[data-foot]") as HTMLElement, modes = el.querySelector("[data-modes]") as HTMLElement;

    const seg = (opts: [string, string][], cur: string, on: (id: string) => void) => {
      for (const [id, label] of opts) {
        const b = document.createElement("button");
        b.textContent = label; b.setAttribute("aria-pressed", String(id === cur));
        b.onclick = () => on(id);
        modes.append(b);
      }
    };
    const btn = (label: string, on: () => void, cls = "btn btn-sm", title?: string) => {
      const b = document.createElement("button");
      b.className = cls; b.textContent = label; b.onclick = on; if (title) b.title = title;
      foot.append(b); return b;
    };
    const copy = (text: string) => { navigator.clipboard?.writeText(text); toast("Copied", "ok"); };

    // An editable text area with Apply / Set NULL; used for text, JSON-as-text and NULL cells.
    const editor = (initial: string, extra?: (ta: HTMLTextAreaElement, apply: HTMLButtonElement) => void) => {
      const ta = document.createElement("textarea");
      ta.className = "field mono flex-1 min-h-0 w-full resize-none text-[12.5px] leading-5";
      ta.style.cssText = "padding:8px;white-space:pre;overflow:auto";
      ta.spellcheck = false; ta.value = initial; ta.readOnly = !editable;
      if (view.kind === "null") ta.placeholder = "NULL";
      body.append(ta);
      btn("Copy", () => copy(ta.value));
      if (editable) {
        const apply = btn("Apply", () => {
          const val: Val = ta.value === "" && view.kind === "null" ? { t: "Null" } : { t: "Text", v: ta.value };
          grid.stageEdit(a.r, a.c, val);
        }, "btn btn-sm btn-primary", "Stage this value (commit it with the table's Commit)");
        apply.disabled = true;
        ta.oninput = () => (apply.disabled = ta.value === initial);
        if (view.kind !== "null") btn("Set NULL", () => grid.stageEdit(a.r, a.c, { t: "Null" }));
        extra?.(ta, apply);
      }
      return ta;
    };

    switch (view.kind) {
      case "null": editor(""); break;
      case "text": editor(view.text); break;
      case "json": {
        seg([["tree", "Tree"], ["text", "Text"]], jsonMode, (id) => { jsonMode = id as "tree" | "text"; paint(); });
        if (jsonMode === "tree" && view.text.length <= TREE_LIMIT) {
          const t = document.createElement("div");
          t.className = "flex-1 min-h-0 overflow-auto field p-2 select-text";
          t.append(jsonNode(null, JSON.parse(view.text), true));
          body.append(t);
          btn("Copy", () => copy(view.text));
          btn("Copy formatted", () => copy(view.pretty));
        } else {
          editor(view.pretty, (ta, apply) => {
            btn("Minify", () => { const m = minifyJson(ta.value); if (m !== null) { ta.value = m; apply.disabled = false; } else toast("Not valid JSON", "error"); });
          });
        }
        break;
      }
      case "image": {
        imgUrl = URL.createObjectURL(new Blob([Uint8Array.from(view.bytes)], { type: view.mime }));
        const wrap = document.createElement("div");
        wrap.className = "flex-1 min-h-0 overflow-auto field flex items-center justify-center p-2";
        const img = document.createElement("img");
        img.src = imgUrl; img.style.cssText = "max-width:100%;max-height:100%;object-fit:contain";
        img.style.imageRendering = "pixelated";
        img.onload = () => { if (img.naturalWidth < 160) img.style.width = Math.max(1, Math.floor(160 / img.naturalWidth)) * img.naturalWidth + "px"; (el.querySelector("[data-meta]") as HTMLElement).textContent = `${meta} · ${img.naturalWidth}×${img.naturalHeight}`; };
        wrap.append(img); body.append(wrap);
        break;
      }
      case "bytes": {
        if (view.text !== null) seg([["hex", "Hex"], ["text", "Text"]], hexMode, (id) => { hexMode = id as "hex" | "text"; paint(); });
        const pre = document.createElement("pre");
        pre.className = "field mono flex-1 min-h-0 overflow-auto text-[12px] leading-5 p-2 select-text";
        pre.style.whiteSpace = "pre";
        pre.textContent = hexMode === "text" && view.text !== null ? view.text : hexDump(view.bytes);
        body.append(pre);
        btn("Copy", () => copy(pre.textContent ?? ""));
        if (editable) btn("Set NULL", () => grid.stageEdit(a.r, a.c, { t: "Null" }));
        break;
      }
    }
  }

  const schedule = () => { if (open && !raf) raf = requestAnimationFrame(paint); };
  const prev = grid.onActive;
  grid.onActive = () => { prev(); schedule(); };

  function toggle(on = !open) {
    open = on;
    el.classList.toggle("hidden", !on);
    if (on) paint(); else { free(); el.replaceChildren(); }
    onToggle?.(on);
  }
  let onToggle: ((on: boolean) => void) | undefined;
  return { el, toggle, get open() { return open; }, set onToggle(f: ((on: boolean) => void) | undefined) { onToggle = f; } };
}
