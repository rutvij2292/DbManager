/** Storage key of one database on one saved connection (history and open-tab drafts are kept under it). */
export const sessionKey = (profileId: string, db: string | null | undefined) => `${profileId}|${db ?? ""}`;

export function ago(at: number, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - at) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
