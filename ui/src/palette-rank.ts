export interface PalObj { name: string; kind: string; schema?: string | null }
export interface PalAction { id: string; label: string; group: string; combo: string }

/** True when the label, or one of its words, starts with `t` ("commit" matches "Commit changes", not "Discard uncommitted changes"). */
function wordMatch(label: string, t: string): boolean {
  const l = label.toLowerCase();
  return l.startsWith(t) || l.split(/[^a-z0-9]+/).some((w) => w.startsWith(t));
}

/** Objects and actions for the ⌘P query. ">" prefix = actions only. */
export function paletteResults(query: string, objects: PalObj[], actions: PalAction[], max = { objects: 50, actions: 6 }): { objects: PalObj[]; actions: PalAction[] } {
  const q = query.trim().toLowerCase();
  const acts = actions.filter((a) => a.id !== "palette");
  if (q.startsWith(">")) {
    const rest = q.slice(1).trim();
    return { objects: [], actions: rest ? acts.filter((a) => wordMatch(a.label, rest)) : acts };
  }
  if (!q) return { objects: objects.slice(0, max.objects), actions: [] };
  const exact: PalObj[] = [], prefix: PalObj[] = [], other: PalObj[] = [];
  for (const o of objects) {
    const n = o.name.toLowerCase();
    if (n === q) exact.push(o);
    else if (n.startsWith(q)) prefix.push(o);
    else if (n.includes(q)) other.push(o);
  }
  return {
    objects: exact.concat(prefix, other).slice(0, max.objects),
    actions: acts.filter((a) => wordMatch(a.label, q)).slice(0, max.actions),
  };
}
