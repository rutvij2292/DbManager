/** Shared dialog + toast helpers. */
export function modal(inner: string, width = 560) {
  const o = document.createElement("div");
  o.className = "fixed inset-0 flex items-center justify-center z-50 select-none";
  o.style.background = "color-mix(in srgb, var(--ink) 32%, transparent)";
  o.style.backdropFilter = "blur(2px)";
  o.innerHTML = `<div class="bg-panel rounded-xl border border-line-strong shadow-pop flex flex-col max-h-[86vh]" style="width:${width}px;max-width:94vw">${inner}</div>`;
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
    t.className = "fixed bottom-10 left-1/2 -translate-x-1/2 z-[60] rounded-lg px-4 py-2 text-[12.5px] shadow-pop border border-line-strong bg-panel max-w-[70vw]";
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
  return (localStorage.getItem("lattice.theme") as Theme) || "light";
}
export function applyTheme(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark");
  localStorage.setItem("lattice.theme", t);
}
