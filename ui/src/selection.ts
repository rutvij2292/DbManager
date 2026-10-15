/** Sidebar multi-select: which names are picked after a plain, ⌘/Ctrl or Shift click. `order` is the visible order. */
export interface Selection { picked: Set<string>; anchor: string | null }

export function clickSelect(sel: Selection, order: string[], name: string, mode: "single" | "toggle" | "range"): Selection {
  if (mode === "toggle") {
    const picked = new Set(sel.picked);
    picked.has(name) ? picked.delete(name) : picked.add(name);
    return { picked, anchor: name };
  }
  const a = mode === "range" && sel.anchor !== null ? order.indexOf(sel.anchor) : -1, b = order.indexOf(name);
  if (a < 0 || b < 0) return { picked: new Set([name]), anchor: name };
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return { picked: new Set(order.slice(lo, hi + 1)), anchor: sel.anchor };
}
