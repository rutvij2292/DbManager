/** Layered layout for ER diagrams: referenced (parent) tables on the left, referencing (child) tables to the right. */
export interface LNode { id: string; w: number; h: number }
/** `from` holds the foreign key; `to` is the table it references. */
export interface LEdge { from: string; to: string }
export interface Placed { x: number; y: number }

const GAP_X = 96, GAP_Y = 30;

export function layout(nodes: LNode[], edges: LEdge[]): { pos: Map<string, Placed>; width: number; height: number } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const real = edges.filter((e) => e.from !== e.to && byId.has(e.from) && byId.has(e.to));
  const degree = new Map<string, number>();
  for (const e of real) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1); }
  const connected = nodes.filter((n) => degree.has(n.id));
  const isolated = nodes.filter((n) => !degree.has(n.id));

  // Longest-path layering; the iteration cap stops reference cycles from looping forever.
  const layer = new Map(connected.map((n) => [n.id, 0]));
  for (let i = 0; i < connected.length + 1; i++) {
    let changed = false;
    for (const e of real) {
      const want = (layer.get(e.to) ?? 0) + 1;
      if (want > (layer.get(e.from) ?? 0) && want <= connected.length) { layer.set(e.from, want); changed = true; }
    }
    if (!changed) break;
  }
  const layers: string[][] = [];
  for (const n of connected) (layers[layer.get(n.id)!] ??= []).push(n.id);
  for (const l of layers) l?.sort((a, b) => (degree.get(b)! - degree.get(a)!) || a.localeCompare(b));

  // Barycentre sweeps: order each layer by the average position of its neighbours to reduce crossings.
  const index = new Map<string, number>();
  const reindex = () => layers.forEach((l) => l?.forEach((id, i) => index.set(id, i)));
  reindex();
  const neighbours = (id: string) => real.filter((e) => e.from === id || e.to === id).map((e) => (e.from === id ? e.to : e.from));
  for (let sweep = 0; sweep < 6; sweep++) {
    const order = sweep % 2 ? [...layers.keys()].reverse() : [...layers.keys()];
    for (const li of order) {
      const l = layers[li];
      if (!l) continue;
      const score = new Map(l.map((id) => {
        const ns = neighbours(id).filter((n) => layer.get(n) !== li);
        return [id, ns.length ? ns.reduce((a, n) => a + (index.get(n) ?? 0), 0) / ns.length : index.get(id)!] as const;
      }));
      l.sort((a, b) => score.get(a)! - score.get(b)!);
      l.forEach((id, i) => index.set(id, i));
    }
  }

  // Coordinates: columns left to right, each column vertically centred on the tallest one.
  const pos = new Map<string, Placed>();
  const present = layers.filter((l): l is string[] => !!l && l.length > 0);
  const colH = present.map((l) => l.reduce((a, id) => a + byId.get(id)!.h, 0) + GAP_Y * (l.length - 1));
  const tallest = Math.max(0, ...colH);
  let x = 0;
  present.forEach((l, ci) => {
    let y = (tallest - colH[ci]) / 2;
    const colW = Math.max(...l.map((id) => byId.get(id)!.w));
    for (const id of l) { pos.set(id, { x, y }); y += byId.get(id)!.h + GAP_Y; }
    x += colW + GAP_X;
  });
  let width = Math.max(0, x - GAP_X), height = tallest;

  // Tables with no relations go in a compact grid underneath rather than one very tall column.
  if (isolated.length) {
    const rowW = Math.max(width, 960);
    let cx = 0, cy = height ? height + GAP_Y * 2 : 0, rowH = 0;
    for (const n of isolated.sort((a, b) => a.id.localeCompare(b.id))) {
      if (cx > 0 && cx + n.w > rowW) { cx = 0; cy += rowH + GAP_Y; rowH = 0; }
      pos.set(n.id, { x: cx, y: cy });
      cx += n.w + GAP_X / 2; rowH = Math.max(rowH, n.h); width = Math.max(width, cx - GAP_X / 2);
    }
    height = cy + rowH;
  }
  return { pos, width, height };
}
