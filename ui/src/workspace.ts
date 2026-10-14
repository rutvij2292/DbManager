/**
 * Tab selection rules. Every tab belongs to exactly one connection ("server") and the UI may only
 * ever look at the tabs of the connection on screen. Keeping these rules here, away from the DOM,
 * lets tests prove a tab can never leak across connections.
 */
export interface Tabbed { conn: { server: unknown } | null }

/** The tabs of one connection, in order. Tabs without a connection belong to nobody. */
export function tabsOf<T extends Tabbed>(all: readonly T[], server: unknown): T[] {
  return server ? all.filter((t) => t.conn?.server === server) : [];
}

/** After closing `closing`, which tab of the SAME connection takes over (the one now in its slot, else the last). */
export function nextAfterClose<T extends Tabbed>(all: readonly T[], closing: T): T | null {
  const server = closing.conn?.server;
  const mine = tabsOf(all, server);
  const i = mine.indexOf(closing);
  const left = mine.filter((t) => t !== closing);
  return left.length ? left[Math.min(Math.max(i, 0), left.length - 1)] : null;
}

/** ⌘1…⌘9: the n-th (1-based) tab of the current connection. */
export function nthTab<T extends Tabbed>(all: readonly T[], server: unknown, n: number): T | null {
  return tabsOf(all, server)[n - 1] ?? null;
}

/** Next / previous tab (wrapping) within the current tab's own connection. */
export function cycleTab<T extends Tabbed>(all: readonly T[], current: T | null, delta: number): T | null {
  if (!current) return null;
  const mine = tabsOf(all, current.conn?.server);
  if (!mine.length) return null;
  return mine[(mine.indexOf(current) + delta + mine.length) % mine.length];
}

/** The tab to show when switching to a connection: the one it last had open, else its most recent. */
export function tabForSwitch<T extends Tabbed>(all: readonly T[], server: unknown, last: T | null | undefined): T | null {
  const mine = tabsOf(all, server);
  return last && mine.includes(last) ? last : mine[mine.length - 1] ?? null;
}
