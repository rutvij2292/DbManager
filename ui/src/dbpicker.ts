import { icon } from "./icons";
import { esc, modal } from "./ui";

const SYSTEM = new Set(["information_schema", "performance_schema", "mysql", "sys", "template0", "template1", "admin", "local", "config", "master", "model", "msdb", "tempdb"]);

/** Searchable list of the databases on the server. Resolves with the chosen name, or null if dismissed. */
export function pickDatabase(databases: string[], current: string | null | undefined): Promise<string | null> {
  return new Promise((resolve) => {
    const m = modal(`
      <div class="px-4 pt-3 pb-2 border-b border-line">
        <div class="text-[15px] font-semibold">Open a database</div>
        <div class="text-soft mt-0.5">${databases.length} on this server</div>
        <div class="relative mt-2.5"><span class="absolute left-2.5 top-[7px] text-muted pointer-events-none">${icon("search", 14)}</span>
          <input id="q" class="field w-full" style="padding-left:30px" placeholder="Search databases" autocomplete="off"/></div>
      </div>
      <div id="list" class="overflow-auto py-1" style="max-height:46vh"></div>`, 460);
    const list = m.q("#list"), q = m.q<HTMLInputElement>("#q");
    let idx = 0, shown: string[] = [], showSystem = false;
    let done = false;
    const finish = (v: string | null) => { if (done) return; done = true; m.close(); resolve(v); };
    const origClose = m.o.querySelector("#q");
    void origClose;
    // Escape / backdrop dismissal is handled by modal(); watch for the overlay disappearing.
    new MutationObserver(() => { if (!document.body.contains(m.o)) finish(null); }).observe(document.body, { childList: true });

    const draw = () => {
      const term = q.value.toLowerCase();
      const all = databases.filter((d) => d.toLowerCase().includes(term));
      const user = all.filter((d) => !SYSTEM.has(d.toLowerCase())), sys = all.filter((d) => SYSTEM.has(d.toLowerCase()));
      shown = [...user, ...(showSystem || term ? sys : [])];
      idx = Math.min(idx, Math.max(0, shown.length - 1));
      const row = (d: string, i: number) => `<div data-i="${i}" class="flex items-center gap-2.5 px-4 h-8 cursor-default ${i === idx ? "bg-accent text-white" : "hover:bg-canvas"}">
        <span class="${i === idx ? "" : "text-muted"}">${icon("database", 14)}</span><span class="truncate">${esc(d)}</span>${d === current ? `<span class="ml-auto text-[11px] ${i === idx ? "" : "text-muted"}">current</span>` : ""}</div>`;
      list.innerHTML = user.map((d, i) => row(d, i)).join("") +
        (sys.length && !showSystem && !term ? `<div id="sys" class="px-4 h-8 flex items-center gap-1.5 text-muted cursor-default hover:text-ink">${icon("chevron", 11)}<span>${sys.length} system databases</span></div>` : "") +
        (showSystem || term ? sys.map((d, i) => row(d, user.length + i)).join("") : "") +
        (!shown.length && !(sys.length && !showSystem) ? `<div class="px-4 py-6 text-center text-muted">No databases match “${esc(q.value)}”.</div>` : "");
      list.querySelectorAll<HTMLElement>("[data-i]").forEach((el) => { el.onclick = () => finish(shown[+el.dataset.i!]); });
      (list.querySelector("#sys") as HTMLElement | null)?.addEventListener("click", () => { showSystem = true; draw(); });
      list.querySelector<HTMLElement>(`[data-i="${idx}"]`)?.scrollIntoView({ block: "nearest" });
    };
    q.oninput = () => { idx = 0; draw(); };
    q.onkeydown = (e) => {
      if (e.key === "ArrowDown") { idx = Math.min(idx + 1, shown.length - 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { idx = Math.max(idx - 1, 0); draw(); e.preventDefault(); }
      else if (e.key === "Enter" && shown[idx]) finish(shown[idx]);
    };
    draw();
    q.focus();
  });
}
