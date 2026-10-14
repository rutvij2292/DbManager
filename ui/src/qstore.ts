/**
 * Favourite queries (stored, per saved connection), query history (memory only, per open database) and
 * drafts of open query tabs (stored, so an editor survives a restart or a disconnect).
 */
export interface HistoryItem { sql: string; at: number; ms: number; ok: boolean }
export interface SavedQuery { id: string; name: string; sql: string; at: number }
export interface Draft { id: string; title: string; sql: string; at: number }

const FKEY = "tabnix.savedQueries", DKEY = "tabnix.drafts";
const HISTORY_MAX = 100, SQL_MAX = 4000, DRAFTS_MAX = 12;

const read = <T>(key: string): Record<string, T[]> => { try { return JSON.parse(localStorage.getItem(key) ?? "{}"); } catch { return {}; } };
const write = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* best effort */ } };

// ---------- history: kept in memory by the caller, never persisted ----------
/** The list with `item` on top; running the same text again moves it up instead of repeating it. Newest first, capped. */
export function pushHistory(list: readonly HistoryItem[], item: HistoryItem, max = HISTORY_MAX): HistoryItem[] {
  const sql = item.sql.trim();
  if (!sql) return [...list];
  return [{ ...item, sql: sql.length > SQL_MAX ? sql.slice(0, SQL_MAX) : sql }, ...list.filter((h) => h.sql !== sql)].slice(0, max);
}

// ---------- favourites ----------
/** Favourites of one connection, by name. */
export function loadSaved(profileId: string): SavedQuery[] {
  return (read<SavedQuery>(FKEY)[profileId] ?? []).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export const findFavorite = (profileId: string, sql: string): SavedQuery | undefined => loadSaved(profileId).find((q) => q.sql === sql.trim());

/** Save under `name`; an existing query with the same name (any case) is replaced. */
export function saveQuery(profileId: string, name: string, sql: string, now = Date.now()): SavedQuery {
  const all = read<SavedQuery>(FKEY);
  const list = (all[profileId] ?? []).filter((q) => q.name.toLowerCase() !== name.toLowerCase());
  const q = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, sql: sql.trim(), at: now };
  all[profileId] = [...list, q];
  write(FKEY, all);
  return q;
}

/** One-click favourite: named after the first words of the query. Returns `added: false` when it already was one. */
export function addFavorite(profileId: string, sql: string, now = Date.now()): { fav: SavedQuery; added: boolean } {
  const text = sql.trim();
  const have = findFavorite(profileId, text);
  if (have) return { fav: have, added: false };
  const base = (text.replace(/\s+/g, " ").slice(0, 40) || "Query").trim();
  const names = new Set(loadSaved(profileId).map((q) => q.name.toLowerCase()));
  let name = base, n = 2;
  while (names.has(name.toLowerCase())) name = `${base} (${n++})`;
  return { fav: saveQuery(profileId, name, text, now), added: true };
}

export function renameQuery(profileId: string, id: string, name: string) {
  const all = read<SavedQuery>(FKEY);
  all[profileId] = (all[profileId] ?? []).filter((q) => q.id === id || q.name.toLowerCase() !== name.toLowerCase()).map((q) => (q.id === id ? { ...q, name } : q));
  write(FKEY, all);
}

export function deleteQuery(profileId: string, id: string) {
  const all = read<SavedQuery>(FKEY);
  all[profileId] = (all[profileId] ?? []).filter((q) => q.id !== id);
  write(FKEY, all);
}

// ---------- drafts of open query tabs, per connection + database ----------
export function loadDrafts(key: string): Draft[] {
  return (read<Draft>(DKEY)[key] ?? []).slice().sort((a, b) => a.at - b.at);
}

/** Keep the current text of a tab. Blank text removes the draft. */
export function saveDraft(key: string, id: string, title: string, sql: string, now = Date.now()) {
  const all = read<Draft>(DKEY);
  const rest = (all[key] ?? []).filter((d) => d.id !== id);
  if (!sql.trim()) all[key] = rest;
  else all[key] = [...rest, { id, title, sql: sql.length > 200_000 ? sql.slice(0, 200_000) : sql, at: (all[key] ?? []).find((d) => d.id === id)?.at ?? now }].slice(-DRAFTS_MAX);
  if (!all[key].length) delete all[key];
  write(DKEY, all);
}

export function removeDraft(key: string, id: string) { saveDraft(key, id, "", ""); }

/** The old persistent history is gone; drop what earlier versions left behind. */
export function dropLegacyHistory() { try { localStorage.removeItem("tabnix.history"); } catch { /* ignore */ } }
