import type { ErSchema, ErTable } from "./api";
import { layout } from "./diagram-layout";
import { icon } from "./icons";

const NS = "http://www.w3.org/2000/svg";
const HEADER = 34, ROW = 22, PAD = 8, MAX_ROWS = 14;

const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Primary and foreign-key columns first (relations attach to them), then the rest, capped. */
function visibleColumns(t: ErTable) {
  const key = t.columns.filter((c) => c.primary_key || c.foreign_key);
  const rest = t.columns.filter((c) => !(c.primary_key || c.foreign_key));
  const room = Math.max(0, MAX_ROWS - key.length);
  const shown = [...key, ...rest.slice(0, room)].sort((a, b) => t.columns.indexOf(a) - t.columns.indexOf(b));
  return { shown, hidden: t.columns.length - shown.length };
}

interface Box { t: ErTable; x: number; y: number; w: number; h: number; g: SVGGElement; rows: Map<string, number> }

/**
 * Interactive ER diagram. Drag a table by its header, drag the background to pan, scroll to pan,
 * pinch / ⌘-scroll to zoom. Hovering a table highlights its relations; double-click opens it.
 */
export function createDiagram(schema: ErSchema, onOpen: (t: ErTable) => void) {
  const root = document.createElement("div");
  root.className = "relative h-full w-full overflow-hidden bg-panel";
  root.style.backgroundImage = "radial-gradient(var(--line-strong) 1px, transparent 1px)";
  root.style.backgroundSize = "22px 22px";
  const svg = el("svg", { width: "100%", height: "100%" });
  svg.style.cssText = "display:block;touch-action:none;user-select:none;cursor:grab";
  const world = el("g");
  const edgeLayer = el("g"), boxLayer = el("g");
  world.append(edgeLayer, boxLayer);
  svg.append(world);
  root.append(svg);

  // Sizes from text length (IBM Plex Mono at 12px is ~7.2px per character).
  const sized = schema.tables.map((t) => {
    const { shown, hidden } = visibleColumns(t);
    const longest = Math.max(t.name.length + 4, ...shown.map((c) => c.name.length + c.type_name.length + 6));
    return { t, shown, hidden, w: Math.max(190, Math.min(380, Math.round(longest * 7.2 + 56))), h: HEADER + (shown.length + (hidden ? 1 : 0)) * ROW + PAD };
  });
  const { pos } = layout(sized.map((s) => ({ id: s.t.id, w: s.w, h: s.h })), schema.relations.map((r) => ({ from: r.from_table, to: r.to_table })));

  const boxes = new Map<string, Box>();
  for (const s of sized) {
    const p = pos.get(s.t.id) ?? { x: 0, y: 0 };
    const g = el("g");
    g.style.cursor = "default";
    const rows = new Map<string, number>();
    g.append(el("rect", { class: "er-card", width: s.w, height: s.h, rx: 9, fill: "var(--panel)", stroke: "var(--line-strong)", "stroke-width": 1 }));
    const head = el("g");
    head.style.cursor = "grab";
    head.append(el("path", { d: `M0 ${HEADER} V9 a9 9 0 0 1 9 -9 H${s.w - 9} a9 9 0 0 1 9 9 V${HEADER} Z`, fill: "var(--canvas)" }));
    head.append(el("line", { x1: 0, x2: s.w, y1: HEADER, y2: HEADER, stroke: "var(--line)" }));
    const title = el("text", { x: 12, y: 22, "font-weight": 600, "font-size": 13, fill: "var(--ink)" }, (s.t.schema && s.t.schema !== "public" ? s.t.schema + "." : "") + s.t.name);
    title.style.fontFamily = "var(--font-sans)";
    head.append(title);
    g.append(head);
    s.shown.forEach((c, i) => {
      const y = HEADER + i * ROW;
      rows.set(c.name, y + ROW / 2);
      if (c.primary_key) {
        // Same key glyph as the icon set, drawn in the 16px grid and scaled to the row.
        const k = el("g", { transform: `translate(9 ${y + 3}) scale(0.9)`, fill: "none", stroke: "var(--warn)", "stroke-width": 1.5, "stroke-linecap": "round", "stroke-linejoin": "round" });
        k.append(el("circle", { cx: 5.2, cy: 10.8, r: 2.6 }), el("path", { d: "m7.1 9 5.6-5.6M10.6 5.5l1.6 1.6M12 4.1l1.4 1.4" }));
        g.append(k);
      }
      else if (c.foreign_key) g.append(el("circle", { cx: 17, cy: y + ROW / 2, r: 3.2, fill: "var(--accent)" }));
      const name = el("text", { x: 30, y: y + 15, "font-size": 12, fill: c.primary_key ? "var(--ink)" : "var(--soft)", "font-weight": c.primary_key ? 600 : 400 }, c.name);
      name.style.fontFamily = "var(--font-mono)";
      const type = el("text", { x: s.w - 10, y: y + 15, "font-size": 11, "text-anchor": "end", fill: "var(--muted)" }, c.type_name.toLowerCase());
      type.style.fontFamily = "var(--font-mono)";
      g.append(name, type);
    });
    if (s.hidden) {
      const more = el("text", { x: 30, y: HEADER + s.shown.length * ROW + 15, "font-size": 11, fill: "var(--muted)" }, `+ ${s.hidden} more column${s.hidden > 1 ? "s" : ""}`);
      more.style.fontFamily = "var(--font-sans)";
      g.append(more);
    }
    boxLayer.append(g);
    boxes.set(s.t.id, { t: s.t, x: p.x, y: p.y, w: s.w, h: s.h, g, rows });
  }

  // Relations: curve from the child's FK column to the parent's key column.
  interface Edge { path: SVGPathElement; from: Box; to: Box; fromCol: string; toCol: string }
  const edges: Edge[] = [];
  for (const r of schema.relations) {
    const from = boxes.get(r.from_table), to = boxes.get(r.to_table);
    if (!from || !to) continue;
    const path = el("path", { fill: "none", stroke: "var(--line-strong)", "stroke-width": 1.4, "marker-end": "url(#er-end)" });
    const tip = el("title", {}, `${r.from_table}.${r.from_columns.join(", ")} → ${r.to_table}.${r.to_columns.join(", ")}`);
    path.append(tip);
    edgeLayer.append(path);
    edges.push({ path, from, to, fromCol: r.from_columns[0], toCol: r.to_columns[0] });
  }
  const defs = el("defs");
  const marker = el("marker", { id: "er-end", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, orient: "auto-start-reverse" });
  marker.append(el("path", { d: "M1 1 L9 5 L1 9 Z", fill: "var(--soft)" }));
  defs.append(marker);
  svg.prepend(defs);

  const rowY = (b: Box, col: string) => b.y + (b.rows.get(col) ?? HEADER / 2);
  function drawEdge(e: Edge) {
    const { from, to } = e;
    const y1 = rowY(from, e.fromCol), y2 = rowY(to, e.toCol);
    let d: string;
    if (from === to) {
      const x = from.x + from.w;
      d = `M ${x} ${y1} C ${x + 54} ${y1}, ${x + 54} ${y1 + 34}, ${x} ${y1 + 34}`;
    } else if (to.x + to.w <= from.x - 20) {           // parent entirely left of child
      const x1 = from.x, x2 = to.x + to.w, k = Math.max(40, (x1 - x2) / 2);
      d = `M ${x1} ${y1} C ${x1 - k} ${y1}, ${x2 + k} ${y2}, ${x2} ${y2}`;
    } else if (from.x + from.w <= to.x - 20) {         // parent entirely right of child
      const x1 = from.x + from.w, x2 = to.x, k = Math.max(40, (x2 - x1) / 2);
      d = `M ${x1} ${y1} C ${x1 + k} ${y1}, ${x2 - k} ${y2}, ${x2} ${y2}`;
    } else {                                           // overlapping columns: loop out the right side
      const x1 = from.x + from.w, x2 = to.x + to.w, k = 60;
      d = `M ${x1} ${y1} C ${x1 + k} ${y1}, ${x2 + k} ${y2}, ${x2} ${y2}`;
    }
    e.path.setAttribute("d", d);
  }
  const place = (b: Box) => b.g.setAttribute("transform", `translate(${b.x} ${b.y})`);
  boxes.forEach(place);
  edges.forEach(drawEdge);

  // Hover: emphasise one table's relations, fade the rest.
  function focus(id: string | null) {
    const touched = new Set<string>(id ? [id] : []);
    for (const e of edges) {
      const on = !!id && (e.from.t.id === id || e.to.t.id === id);
      if (on) { touched.add(e.from.t.id); touched.add(e.to.t.id); }
      e.path.setAttribute("stroke", on ? "var(--accent)" : "var(--line-strong)");
      e.path.setAttribute("stroke-width", on ? "2" : "1.4");
      e.path.style.opacity = !id || on ? "1" : "0.25";
    }
    boxes.forEach((b, bid) => { b.g.style.opacity = !id || touched.has(bid) ? "1" : "0.4"; });
  }
  boxes.forEach((b, id) => {
    b.g.addEventListener("mouseenter", () => focus(id));
    b.g.addEventListener("mouseleave", () => focus(null));
    b.g.addEventListener("dblclick", () => onOpen(b.t));
  });

  // Pan / zoom / drag.
  let tx = 24, ty = 24, k = 1;
  const apply = () => world.setAttribute("transform", `translate(${tx} ${ty}) scale(${k})`);
  const zoomAt = (cx: number, cy: number, factor: number) => {
    const nk = Math.min(2.5, Math.max(0.15, k * factor));
    tx = cx - ((cx - tx) / k) * nk; ty = cy - ((cy - ty) / k) * nk; k = nk; apply();
  };
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
    else { tx -= e.deltaX; ty -= e.deltaY; apply(); }
  }, { passive: false });
  let drag: { kind: "pan" | "box"; sx: number; sy: number; ox: number; oy: number; box?: Box } | null = null;
  svg.addEventListener("pointerdown", (e) => {
    const headEl = (e.target as Element).closest("g[style*='grab']");
    const owner = headEl && [...boxes.values()].find((b) => b.g.contains(headEl));
    drag = owner ? { kind: "box", sx: e.clientX, sy: e.clientY, ox: owner.x, oy: owner.y, box: owner } : { kind: "pan", sx: e.clientX, sy: e.clientY, ox: tx, oy: ty };
    svg.setPointerCapture(e.pointerId);
    svg.style.cursor = "grabbing";
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (drag.kind === "pan") { tx = drag.ox + dx; ty = drag.oy + dy; apply(); }
    else if (drag.box) {
      drag.box.x = drag.ox + dx / k; drag.box.y = drag.oy + dy / k;
      place(drag.box);
      edges.filter((ed) => ed.from === drag!.box || ed.to === drag!.box).forEach(drawEdge);
    }
  });
  const end = () => { drag = null; svg.style.cursor = "grab"; };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);

  function fit() {
    if (!boxes.size) return;
    const xs = [...boxes.values()];
    const minX = Math.min(...xs.map((b) => b.x)), minY = Math.min(...xs.map((b) => b.y));
    const maxX = Math.max(...xs.map((b) => b.x + b.w)), maxY = Math.max(...xs.map((b) => b.y + b.h));
    const r = svg.getBoundingClientRect();
    const nk = Math.min(1.1, Math.max(0.15, Math.min((r.width - 80) / (maxX - minX || 1), (r.height - 80) / (maxY - minY || 1))));
    k = nk; tx = (r.width - (maxX - minX) * nk) / 2 - minX * nk; ty = (r.height - (maxY - minY) * nk) / 2 - minY * nk; apply();
  }

  // Controls
  const bar = document.createElement("div");
  bar.className = "absolute right-4 bottom-4 flex items-center gap-1 p-1 rounded-xl bg-panel border border-line-strong shadow-pop";
  const mk = (html: string, title: string, f: () => void) => {
    const b = document.createElement("button");
    b.className = "btn btn-ghost"; b.style.cssText = "min-width:28px;padding:0 6px;justify-content:center";
    b.innerHTML = html; b.title = title; b.onclick = f;
    return b;
  };
  const center = () => { const r = svg.getBoundingClientRect(); return [r.width / 2, r.height / 2] as const; };
  bar.append(
    mk(icon("minus", 14), "Zoom out", () => zoomAt(...center(), 1 / 1.25)),
    mk(icon("plus", 14), "Zoom in", () => zoomAt(...center(), 1.25)),
    mk("<span>Fit</span>", "Fit everything on screen", fit),
    mk(icon("download", 14) + "<span>SVG</span>", "Save the diagram as an SVG file", () => exportSvg()),
  );
  root.append(bar);

  function exportSvg() {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.querySelector("g[transform]")?.setAttribute("transform", "translate(24 24)");
    const xs = [...boxes.values()];
    const w = Math.max(...xs.map((b) => b.x + b.w)) + 48, h = Math.max(...xs.map((b) => b.y + b.h)) + 48;
    clone.setAttribute("xmlns", NS); clone.setAttribute("width", String(w)); clone.setAttribute("height", String(h)); clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
    // Bake the theme's colours in so the file renders the same outside the app.
    const cs = getComputedStyle(document.documentElement);
    let text = new XMLSerializer().serializeToString(clone);
    text = text.replace(/var\((--[\w-]+)\)/g, (_, v) => cs.getPropertyValue(v).trim() || "#888");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`<?xml version="1.0"?>\n` + text], { type: "image/svg+xml" }));
    a.download = "er-diagram.svg";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Fit once the element has a real size.
  requestAnimationFrame(() => requestAnimationFrame(fit));
  new ResizeObserver(() => { if (root.isConnected && k === 1 && tx === 24) fit(); }).observe(root);
  return { el: root, fit };
}
