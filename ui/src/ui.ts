/** Shared dialog + toast helpers. */
export function modal(inner: string, width = 560) {
  const o = document.createElement("div");
  o.className = "fixed inset-0 flex items-center justify-center z-50 select-none";
  o.style.background = "color-mix(in srgb, var(--ink) 28%, transparent)";
  o.style.backdropFilter = "blur(8px) saturate(1.2)";
  (o.style as CSSStyleDeclaration & { webkitBackdropFilter: string }).webkitBackdropFilter = "blur(8px) saturate(1.2)";
  o.innerHTML = `<div class="glass-strong rounded-2xl flex flex-col max-h-[86vh]" style="width:${width}px;max-width:94vw">${inner}</div>`;
  document.body.append(o);
  const close = () => { o.remove(); window.removeEventListener("keydown", onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  window.addEventListener("keydown", onKey, true);
  o.addEventListener("mousedown", (e) => { if (e.target === o) close(); });
  return { o, close, q: <T extends HTMLElement>(s: string) => o.querySelector(s) as T };
}

let toastTimer: number | undefined;
export function toast(msg: string, tone: "ok" | "error" | "info" = "info") {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "fixed bottom-10 left-1/2 -translate-x-1/2 z-[60] rounded-lg px-4 py-2 text-[13.5px] shadow-pop border border-line-strong bg-panel max-w-[70vw]";
    document.body.append(t);
  }
  t.style.borderLeft = `3px solid ${tone === "ok" ? "var(--ok)" : tone === "error" ? "var(--danger)" : "var(--accent)"}`;
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t!.style.display = "none"; }, tone === "error" ? 7000 : 3500);
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export type Theme = "light" | "dark";
export function currentTheme(): Theme {
  return (localStorage.getItem("tabnix.theme") as Theme) || "light";
}
export function applyTheme(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark");
  localStorage.setItem("tabnix.theme", t);
}

export interface MenuItem { label: string; hint?: string; danger?: boolean; disabled?: boolean; divider?: boolean; action?: () => void }

/** Right-click menu at (x, y). Closes on outside click, Escape, scroll or window blur. */
export function contextMenu(x: number, y: number, items: MenuItem[]) {
  document.getElementById("ctx")?.remove();
  const m = document.createElement("div");
  m.id = "ctx";
  m.className = "fixed z-[70] min-w-[200px] py-1 rounded-lg border border-line-strong bg-panel shadow-pop text-[13.5px] select-none";
  m.innerHTML = items.map((it, i) => it.divider
    ? `<div class="my-1 h-px bg-line"></div>`
    : `<div data-i="${i}" class="flex items-center gap-3 mx-1.5 px-2.5 h-8 rounded-lg ${it.disabled ? "opacity-40" : "hover:bg-accent hover:text-white cursor-default"} ${it.danger ? "text-danger" : ""}"><span class="flex-1 truncate">${esc(it.label)}</span>${it.hint ? `<span class="text-[12px] opacity-60">${esc(it.hint)}</span>` : ""}</div>`).join("");
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + "px";
  m.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + "px";
  const close = () => { m.remove(); window.removeEventListener("mousedown", away, true); window.removeEventListener("keydown", key, true); window.removeEventListener("blur", close); window.removeEventListener("wheel", close, true); };
  const away = (e: MouseEvent) => { if (!m.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  m.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    const it = el && items[+el.dataset.i!];
    if (it && !it.disabled) { close(); it.action?.(); }
  });
  m.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("mousedown", away, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", close);
  window.addEventListener("wheel", close, { capture: true, passive: true });
}

/** A stable colour per tag, so "Work" looks the same on the home screen, in the form and in filters. */
const TAG_HUES = ["--accent", "--spark", "--eng-mongo", "--eng-mssql", "--eng-redis", "--eng-pg", "--eng-sqlite", "--eng-maria"];
export function tagHue(tag: string): string {
  let h = 0;
  for (const c of tag.trim().toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `var(${TAG_HUES[h % TAG_HUES.length]})`;
}
export function tagChip(tag: string, extra = ""): string {
  const hue = tagHue(tag);
  return `<span class="inline-flex items-center gap-1.5 shrink-0 ${extra}" style="height:20px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:500;color:var(--ink);background:color-mix(in srgb, ${hue} 14%, transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb, ${hue} 30%, transparent)"><span style="width:6px;height:6px;border-radius:3px;background:${hue}"></span>${esc(tag)}</span>`;
}
export const STARTER_TAGS = ["Work", "Practice", "Projects"];
