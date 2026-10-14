/**
 * Recent query sessions, kept per connection + database. A session is the text of a query tab that was closed
 * (or still open when the app quit). A new query tab lists them; once that tab is closed they are dropped, so
 * every session is offered at least once and then goes away.
 */
export interface Session { sql: string; at: number }

const KEY = "tabnix.sessions";
const MAX = 8;

type Store = Record<string, Session[]>;
const read = (): Store => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Store; } catch { return {}; } };
const write = (s: Store) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage full or unavailable: history is best-effort */ } };

/** Storage key of one database on one saved connection. */
export const sessionKey = (profileId: string, db: string | null | undefined) => `${profileId}|${db ?? ""}`;

/** Newest first. */
export function loadSessions(key: string): Session[] {
  return (read()[key] ?? []).slice().sort((a, b) => b.at - a.at);
}

/** Remember a query text. Blank text is ignored; the same text replaces its older entry instead of repeating. */
export function addSession(key: string, sql: string, at = Date.now()) {
  const text = sql.trim();
  if (!text) return;
  const all = read();
  all[key] = [{ sql: text, at }, ...(all[key] ?? []).filter((s) => s.sql !== text)].slice(0, MAX);
  write(all);
}

/** Drop sessions that have been shown. */
export function removeSessions(key: string, shown: Session[]) {
  if (!shown.length) return;
  const all = read();
  const gone = new Set(shown.map((s) => s.sql));
  const left = (all[key] ?? []).filter((s) => !gone.has(s.sql));
  if (left.length) all[key] = left; else delete all[key];
  write(all);
}

export function ago(at: number, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - at) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
