import { api, type TpEntry } from "./api";
import { ENGINE_NAMES, engineBadge, envColor } from "./icons";
import { esc, modal, toast } from "./ui";

const where = (c: TpEntry) => c.path ?? c.socket ?? [c.user && `${c.user}@`, c.host, c.port && `:${c.port}`, c.database && `/${c.database}`].filter(Boolean).join("");

/** Dialog that brings saved TablePlus connections into Tabnix. Resolves true if anything was imported. */
export function showTablePlusImport(entries: TpEntry[]): Promise<boolean> {
  return new Promise((resolve) => {
    const supported = entries.filter((e) => e.kind);
    const m = modal(`
      <div class="px-5 pt-4 pb-3 border-b border-line">
        <div class="text-[16px] font-semibold">Import from TablePlus</div>
        <div class="text-soft mt-0.5">${entries.length} connection${entries.length === 1 ? "" : "s"} found on this Mac. Choose the ones to bring over.</div>
      </div>
      <div id="list" class="overflow-auto flex-1 py-1"></div>
      <div class="px-5 py-3 border-t border-line flex flex-col gap-2">
        <label class="flex items-start gap-2"><input id="pw" type="checkbox" class="mt-0.5" checked/>
          <span>Copy saved passwords from the macOS Keychain<br/><span class="text-muted text-[13px]">macOS asks for permission once per connection. Choose Allow, or skip this and enter passwords the first time you connect.</span></span></label>
        <div class="flex items-center gap-2 mt-1">
          <button id="all" class="btn btn-ghost">Select all</button>
          <span class="flex-1"></span>
          <button id="cancel" class="btn btn-ghost">Cancel</button>
          <button id="go" class="btn btn-primary"></button>
        </div>
      </div>`, 600);
    const checked = new Set(supported.filter((e) => !e.already_imported).map((e) => e.id));
    const list = m.q("#list"), go = m.q<HTMLButtonElement>("#go");

    const draw = () => {
      list.innerHTML = entries.map((e) => {
        const off = !e.kind;
        const note = off ? `${esc(e.driver)} isn't supported yet` : e.already_imported ? "Already imported — importing again updates it" : e.ssh_host ? `via SSH ${esc(e.ssh_host)}` : "";
        return `<label class="flex items-center gap-3 px-5 py-2 ${off ? "opacity-50" : "hover:bg-canvas cursor-pointer"}" style="box-shadow: inset 3px 0 0 ${envColor(e.environment)}">
          <input type="checkbox" data-id="${e.id}" ${checked.has(e.id) ? "checked" : ""} ${off ? "disabled" : ""}/>
          ${engineBadge(e.kind, 28)}
          <span class="min-w-0 flex-1"><span class="block font-medium truncate">${esc(e.name)}</span>
            <span class="block mono text-[12px] text-muted truncate">${esc(where(e) || ENGINE_NAMES[e.kind ?? ""] || e.driver)}</span></span>
          <span class="text-[12px] text-muted shrink-0 text-right">${note}</span></label>`;
      }).join("");
      list.querySelectorAll<HTMLInputElement>("input[data-id]").forEach((i) => (i.onchange = () => { i.checked ? checked.add(i.dataset.id!) : checked.delete(i.dataset.id!); sync(); }));
      sync();
    };
    const sync = () => {
      go.disabled = checked.size === 0;
      go.textContent = checked.size ? `Import ${checked.size} connection${checked.size === 1 ? "" : "s"}` : "Import";
    };
    m.q("#all").onclick = () => { supported.forEach((e) => checked.add(e.id)); draw(); };
    m.q("#cancel").onclick = () => { m.close(); resolve(false); };
    go.onclick = async () => {
      go.disabled = true; go.textContent = "Importing…";
      try {
        const r = await api.tableplusImport([...checked], m.q<HTMLInputElement>("#pw").checked);
        const pw = m.q<HTMLInputElement>("#pw").checked ? (r.passwords_missing ? ` Passwords copied for ${r.passwords_copied}; ${r.passwords_missing} need to be entered on first connect.` : ` Passwords copied for ${r.passwords_copied}.`) : "";
        toast(`Imported ${r.imported} connection${r.imported === 1 ? "" : "s"}.${pw}`, "ok");
        m.close(); resolve(r.imported > 0);
      } catch (e) {
        toast("Import failed: " + e, "error");
        sync();
      }
    };
    draw();
  });
}
