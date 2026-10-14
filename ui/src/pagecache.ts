/**
 * Least-recently-used cache of result pages. Keeps memory flat however far the user scrolls:
 * pages beyond `max` are dropped (and fetched again from Rust if scrolled back to), except pinned
 * ones, which hold rows with staged edits that a commit still needs.
 */
export class PageCache<T> {
  private pages = new Map<number, T>();
  constructor(readonly max: number) {}

  get size() { return this.pages.size; }
  has(page: number) { return this.pages.has(page); }
  /** Read without changing recency. */
  peek(page: number): T | undefined { return this.pages.get(page); }
  values() { return this.pages.values(); }
  keys() { return this.pages.keys(); }
  drop(page: number) { this.pages.delete(page); }
  clear() { this.pages.clear(); }

  /** Mark a page as most recently used. Returns false when it isn't cached. */
  touch(page: number): boolean {
    const v = this.pages.get(page);
    if (v === undefined) return false;
    this.pages.delete(page); this.pages.set(page, v);
    return true;
  }

  /** Store a page as most recently used, then drop the oldest unpinned pages over the limit. */
  set(page: number, value: T, pinned: ReadonlySet<number> = new Set()) {
    this.pages.delete(page); this.pages.set(page, value);
    for (const p of this.pages.keys()) {
      if (this.pages.size <= this.max) break;
      if (p !== page && !pinned.has(p)) this.pages.delete(p);
    }
  }
}
