/**
 * Query history (what was run, per connection + database) and saved queries (named, per connection).
 * Both live in localStorage: small, no files to manage, no cost while idle.
 */
export interface HistoryItem { sql: string; at: number; ms: number; ok: boolean }
export interface SavedQuery { id: string; name: string; sql: string; at: number }

const HKEY = "tabnix.history", SKEY = "tabnix.savedQueries";
const HISTORY_MAX = 100, SQL_MAX = 4000;

const read = <T>(key: string): Record<string, T[]> => { try { return JSON.parse(localStorage.getItem(key) ?? "{}"); } catch { return {}; } };
const write = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* best effort */ } };

/** Newest first. */
export function loadHistory(key: string): HistoryItem[] {
  return (read<HistoryItem>(HKEY)[key] ?? []).slice().sort((a, b) => b.at - a.at);
}

/** Record a run. Running the same text again moves it to the top instead of repeating it. */
export function addHistory(key: string, item: HistoryItem) {
  const sql = item.sql.trim();
  if (!sql) return;
  const all = read<HistoryItem>(HKEY);
  all[key] = [{ ...item, sql: sql.length > SQL_MAX ? sql.slice(0, SQL_MAX) : sql }, ...(all[key] ?? []).filter((h) => h.sql !== sql)].slice(0, HISTORY_MAX);
  write(HKEY, all);
}

export function removeHistory(key: string, at: number) {
  const all = read<HistoryItem>(HKEY);
  all[key] = (all[key] ?? []).filter((h) => h.at !== at);
  write(HKEY, all);
}

export function clearHistory(key: string) {
  const all = read<HistoryItem>(HKEY);
  delete all[key];
  write(HKEY, all);
}

/** Saved queries of one connection, by name. */
export function loadSaved(profileId: string): SavedQuery[] {
  return (read<SavedQuery>(SKEY)[profileId] ?? []).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Save under `name`; an existing query with the same name (any case) is replaced. */
export function saveQuery(profileId: string, name: string, sql: string, now = Date.now()): SavedQuery {
  const all = read<SavedQuery>(SKEY);
  const list = (all[profileId] ?? []).filter((q) => q.name.toLowerCase() !== name.toLowerCase());
  const q = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, sql, at: now };
  all[profileId] = [...list, q];
  write(SKEY, all);
  return q;
}

export function renameQuery(profileId: string, id: string, name: string) {
  const all = read<SavedQuery>(SKEY);
  all[profileId] = (all[profileId] ?? []).filter((q) => q.id === id || q.name.toLowerCase() !== name.toLowerCase()).map((q) => (q.id === id ? { ...q, name } : q));
  write(SKEY, all);
}

export function deleteQuery(profileId: string, id: string) {
  const all = read<SavedQuery>(SKEY);
  all[profileId] = (all[profileId] ?? []).filter((q) => q.id !== id);
  write(SKEY, all);
}
