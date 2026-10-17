/** Last-connected timestamps per saved profile id, used to order the launcher. */
export type Used = Record<string, number>;

/** Returns a new map with `id` stamped `now`, keeping only the newest `keep` ids. */
export function touchRecent(used: Used, id: string, now: number, keep = 200): Used {
  const next: Used = { ...used, [id]: now };
  const ids = Object.keys(next).sort((a, b) => next[b] - next[a]).slice(0, keep);
  const out: Used = {};
  for (const k of ids) out[k] = next[k];
  return out;
}

/** Most recently used first; never-used ones follow, alphabetically. Ties fall back to name. */
export function sortByRecent<T extends { id: string; name: string }>(list: T[], used: Used): T[] {
  return [...list].sort((a, b) => (used[b.id] ?? 0) - (used[a.id] ?? 0) || a.name.localeCompare(b.name));
}
