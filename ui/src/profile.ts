/**
 * Self-driving memory scenarios for scripts/memprofile.sh. Loaded only when the UI is built with
 * VITE_PROFILE=1, so shipped builds contain none of it. The scenario name comes from the
 * TABNIX_PROFILE environment variable (read by the Rust side, which only has it in `profile` builds).
 */
import { invoke } from "@tauri-apps/api/core";
import { api, type Profile } from "./api";

interface Hooks {
  useConnection(id: number, p: Profile): Promise<void>;
  exec(t: any, sql: string): Promise<void>;
  openTable(name: string): void;
  closeTab(t: any): void;
  activate(t: any): void;
  tabs: any[];
  conn(): { objects: unknown[] } | null;
}

const log = (msg: string) => invoke("profile_log", { msg });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(h: Hooks) {
  const path = await invoke<string | null>("profile_fixture");
  if (!path) throw new Error("TABNIX_PROFILE_DB is not set");
  const p: Profile = { id: "profile-fixture", name: "fixture", kind: "sqlite", path };
  await h.useConnection(await api.connect({ kind: "sqlite", path }), p);
  for (let i = 0; i < 200 && !h.conn()?.objects.length; i++) await sleep(50);
}

/** Visit the first 60 pages (12k rows; a page that takes over 2 s is skipped and counted) once, top to bottom, waiting for each page to arrive. */
async function scrollThrough(tab: any) {
  const body = Array.from((tab.grid.el as HTMLElement).querySelectorAll<HTMLElement>("*")).find((e) => e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== "visible");
  if (!body) return;
  const step = 200 * 30; // one grid page (PAGE rows x ROW_H px); no timers: a backgrounded WebView throttles them
  let peak = 0, slow = 0;
  const wd = setInterval(() => log(`watchdog inflight=${(tab.grid as any).inflight.size} loading=${[...(tab.grid as any).loading]} scrollTop=${body.scrollTop}`), 4000);
  await log(`scroll start: height=${body.scrollHeight} client=${body.clientHeight}`);
  for (let y = 0; y < Math.min(body.scrollHeight, 60 * step); y += step) {
    body.scrollTop = y; body.dispatchEvent(new Event("scroll"));
    if (await Promise.race([tab.grid.idle().then(() => false), sleep(2000).then(() => true)])) slow++; // a delayed IPC response: don't wait for it
    peak = Math.max(peak, tab.grid.cachedPages);
    if (y % (step * 10) === 0) await log(`t=${Math.round(performance.now())}ms y=${y} cached=${tab.grid.cachedPages}`);
  }
  clearInterval(wd);
  body.scrollTop = 0; body.dispatchEvent(new Event("scroll"));
  await Promise.race([tab.grid.idle(), sleep(2000)]);
  await log(`pages cached: peak ${peak}, now ${tab.grid.cachedPages}, pages that took >2s: ${slow}`);
}

const largeResult = async (h: Hooks) => {
  await log("exec start");
  await h.exec(h.tabs[0], "SELECT * FROM big");
  await log("exec done");
  await scrollThrough(h.tabs[0]);
  await log("scroll done");
};
const manyTabs = async (h: Hooks) => {
  const before = h.tabs.length;
  for (let i = 0; i < 20; i++) h.openTable("t" + String(i).padStart(3, "0"));
  // each tab describes, then runs its SELECT; wait until every tab has a result and nothing is running
  for (let i = 0; i < 300 && (h.tabs.length < before + 20 || h.tabs.some((t) => t.running || (t.kind === "table" && !/rows/.test(t.status.textContent ?? "")))); i++) await sleep(50);
};

/** Like a working session on real business tables: ten wide 1000-row table tabs, switching between them, SQL log open. */
const wideSession = async (h: Hooks) => {
  const before = h.tabs.length;
  for (let i = 0; i < 10; i++) h.openTable("w" + String(i).padStart(2, "0"));
  for (let i = 0; i < 400 && (h.tabs.length < before + 10 || h.tabs.some((t) => t.running || (t.kind === "table" && !/rows/.test(t.status.textContent ?? "")))); i++) await sleep(50);
  for (const t of h.tabs) { h.activate(t); await sleep(120); }
};

/** 200k-row result with the cell inspector open, stepping across cells of different columns. */
const inspectLarge = async (h: Hooks) => {
  await connect(h);
  const t = h.tabs[0];
  await h.exec(t, "SELECT * FROM big");
  await log("inspect: exec done");
  t.inspector.toggle(true);
  const cols = t.grid.columns.length;
  for (let i = 0; i < 400; i++) { t.grid.gotoCell(i * 7, i % cols); await Promise.resolve(); }
  await log("inspect: stepped");
};

const typeInto = async (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event("input")); await sleep(400); };
const searchDone = async (bar: HTMLElement) => { for (let i = 0; i < 1200; i++) { const c = bar.querySelector("[data-count]")?.textContent ?? ""; if (c && !/Searching/.test(c)) return c; await sleep(50); } return "timeout"; };

/** Find across all 200k rows of a result (every page is read once, none kept), then step through matches. */
const findLarge = async (h: Hooks) => {
  await connect(h);
  const t = h.tabs[0];
  await h.exec(t, "SELECT * FROM big");
  t.gridFind.open();
  await typeInto(t.gridFind.el.querySelector("[data-q]"), "1");
  await log("find: " + await searchDone(t.gridFind.el));
  for (let i = 0; i < 200; i++) t.grid.stepMatch(1);
};

/** Replace all on an editable 200k-row table: the cap is 10k staged cells. */
const replaceLarge = async (h: Hooks) => {
  await connect(h);
  h.openTable("big");
  const t = h.tabs.find((x) => x.kind === "table" && x.table === "big");
  for (let i = 0; i < 400 && !(t.grid.currentSummary && t.cols); i++) await sleep(50);
  t.gridFind.open();
  await typeInto(t.gridFind.el.querySelector("[data-q]"), "1");
  await log("find: " + await searchDone(t.gridFind.el));
  (t.gridFind.el.querySelector("[data-rep]") as HTMLInputElement).value = "2";
  (t.gridFind.el.querySelector("[data-rep]") as HTMLInputElement).dispatchEvent(new Event("input"));
  (t.gridFind.el.querySelector("[data-all]") as HTMLElement).click();
  await sleep(4000);
  await log("pending after replace all: " + t.grid.pendingCount + ", pages cached " + t.grid.cachedPages);
};

const SCENARIOS: Record<string, (h: Hooks) => Promise<void>> = {
  cold: async () => {},
  connected: connect,
  large: async (h) => { await connect(h); await largeResult(h); },
  // same query, but only the first screen is ever viewed (isolates the cost of scrolling through everything)
  large_view: async (h) => { await connect(h); await h.exec(h.tabs[0], "SELECT * FROM big"); },
  // a query that returns 2M rows: only 200k may ever be held, and reading must stop there
  huge: async (h) => { await connect(h); await h.exec(h.tabs[0], "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<2000000) SELECT i, 'name '||i, 'user'||i||'@example.com', i*3, i*1.5, '2026-01-01', 'note note note '||i FROM c"); },
  inspect: inspectLarge, find: findLarge, replace: replaceLarge,
  tabs20: async (h) => { await connect(h); await manyTabs(h); },
  wide10: async (h) => { await connect(h); await wideSession(h); },
  after_close: async (h) => {
    await connect(h); await largeResult(h); await manyTabs(h);
    for (const t of [...h.tabs]) h.closeTab(t);
  },
};

export async function install(h: Hooks) {
  const name = await invoke<string | null>("profile_scenario");
  if (!name) return;
  const run = SCENARIOS[name];
  if (!run) { console.error("unknown scenario", name); return; }
  try { await run(h); await invoke("profile_ready", { name }); }
  catch (e) { console.error(e); await invoke("profile_ready", { name: name + " FAILED: " + e }); }
}
