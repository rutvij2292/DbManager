import { confirmDanger, safetyLevel } from "./dbadmin";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type ConnConfig, type Profile } from "./api";
import { esc, tagChip, STARTER_TAGS } from "./ui";

interface Kind { id: string; label: string; port?: number; file?: boolean }
const KINDS: Kind[] = [
  { id: "postgres", label: "PostgreSQL", port: 5432 },
  { id: "mysql", label: "MySQL", port: 3306 },
  { id: "mariadb", label: "MariaDB", port: 3306 },
  { id: "mssql", label: "SQL Server", port: 1433 },
  { id: "redis", label: "Redis", port: 6379 },
  { id: "mongo", label: "MongoDB", port: 27017 },
  { id: "sqlite", label: "SQLite", file: true },
  { id: "cockroach", label: "CockroachDB", port: 26257 },
  { id: "redshift", label: "Amazon Redshift", port: 5439 },
  { id: "greenplum", label: "Greenplum", port: 5432 },
];

const field = "w-full bg-panel border border-line-strong rounded px-2 py-1 outline-none focus:border-accent";

/** Connection manager modal: saved list on the left, form on the right. */
export function showConnectionManager(onConnect: (connId: number, p: Profile) => Promise<void>) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 bg-black/50 flex items-center justify-center z-50 select-none";
  overlay.dataset.modal = "";
  overlay.innerHTML = `
    <div class="w-[760px] h-[620px] bg-raised rounded-lg shadow-2xl border border-line-strong flex overflow-hidden">
      <div class="w-56 bg-panel border-r border-line-strong flex flex-col">
        <div id="list" class="flex-1 overflow-auto p-1"></div>
        <button id="new" class="m-2 bg-raised hover:bg-raised2 rounded py-1">+ New connection</button>
      </div>
      <form id="form" class="flex-1 p-4 flex flex-col gap-2 text-[13.5px]">
        <label>Name <input name="name" class="${field}" placeholder="Local Postgres"/></label>
        <div>
          <div class="mb-1">Tags <span class="text-muted">· group connections, e.g. Work or Practice</span></div>
          <div id="tagbox" class="${field} flex flex-wrap items-center gap-1.5" style="height:auto;min-height:32px;padding-top:4px;padding-bottom:4px">
            <span id="tagchips" class="contents"></span>
            <input id="taginput" class="flex-1 min-w-[120px] bg-transparent outline-none" style="height:22px" placeholder="Add a tag, then press Enter"/>
          </div>
          <div id="tagsug" class="flex flex-wrap gap-1.5 mt-1.5"></div>
        </div>
        <div class="flex gap-2 items-end">
          <label class="w-44">Environment <select name="environment" class="${field}"><option value="local">Local</option><option value="staging">Staging</option><option value="production">Production</option></select></label>
          <label class="w-60" title="Protected: truncate/drop are blocked and every write asks first. Read-only: nothing can be changed.">Safety <select name="safety" class="${field}"><option value="off">Off</option><option value="protected">Protected</option><option value="readonly">Read-only</option></select></label>
        </div>
        <label>Type <select name="kind" class="${field}">${KINDS.map((k) => `<option value="${k.id}">${k.label}</option>`).join("")}</select></label>
        <div id="net" class="flex flex-col gap-2 overflow-auto">
          <div class="flex gap-2"><label class="flex-1">Host <input name="host" class="${field}" value="127.0.0.1"/></label>
          <label class="w-24">Port <input name="port" type="number" class="${field}"/></label></div>
          <div class="flex gap-2"><label class="flex-1">User <input name="user" class="${field}"/></label>
          <label class="flex-1">Password <input name="password" type="password" class="${field}" placeholder="(stored in Keychain)"/></label></div>
          <div class="flex gap-2"><label class="flex-1">Database <input name="database" class="${field}"/></label>
          <label class="w-44">SSL <select name="ssl" class="${field}"><option value="prefer">Prefer</option><option value="disable">Off</option><option value="require">Require</option><option value="verify">Verify certificate</option></select></label></div>
          <label class="flex items-center gap-2 mt-1"><input type="checkbox" name="usessh"/> Connect over SSH (uses your ssh keys / agent)</label>
          <div id="ssh" class="hidden flex flex-col gap-2">
            <div class="flex gap-2"><label class="flex-1">SSH host <input name="ssh_host" class="${field}"/></label>
            <label class="w-20">Port <input name="ssh_port" type="number" class="${field}" placeholder="22"/></label>
            <label class="w-32">User <input name="ssh_user" class="${field}"/></label></div>
            <label>Private key (optional) <input name="ssh_key" class="${field}" placeholder="~/.ssh/id_ed25519"/></label>
          </div>
        </div>
        <div id="file" class="hidden flex gap-2 items-end"><label class="flex-1">File <input name="path" class="${field}"/></label>
          <button type="button" id="browse" class="bg-raised2 hover:bg-raised2 rounded px-3 py-1">Browse…</button></div>
        <div id="msg" class="text-[13px] min-h-4 mt-1"></div>
        <div class="mt-auto flex gap-2 justify-end">
          <button type="button" id="del" class="mr-auto text-danger hover:text-danger">Delete</button>
          <button type="button" id="close" class="px-3 py-1 rounded hover:bg-raised2">Close</button>
          <button type="button" id="test" class="px-3 py-1 rounded bg-raised2 hover:bg-raised2">Test</button>
          <button type="button" id="save" class="px-3 py-1 rounded bg-raised2 hover:bg-raised2">Save</button>
          <button type="submit" class="px-3 py-1 rounded btn-primary">Connect</button>
        </div>
      </form>
    </div>`;
  document.body.append(overlay);
  const q = <T extends HTMLElement>(s: string) => overlay.querySelector(s) as T;
  const form = q<HTMLFormElement>("#form");
  const el = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const msg = (t: string, bad = false) => { const m = q("#msg"); m.textContent = t; m.className = "text-[13px] min-h-4 mt-1 " + (bad ? "text-danger" : "text-ok"); };
  let current: Profile | null = null;

  const kindOf = () => KINDS.find((k) => k.id === el("kind").value)!;
  const syncKind = () => {
    const k = kindOf();
    q("#net").classList.toggle("hidden", !!k.file);
    q("#file").classList.toggle("hidden", !k.file);
    q("#ssh").classList.toggle("hidden", !el("usessh").checked);
    if (k.port && (!el("port").value || KINDS.some((x) => String(x.port) === el("port").value))) el("port").value = String(k.port);
  };
  const toConfig = (): ConnConfig => ({
    kind: el("kind").value,
    host: el("host").value || undefined,
    port: el("port").value ? +el("port").value : undefined,
    user: el("user").value || undefined,
    password: el("password").value || undefined,
    database: el("database").value || undefined,
    path: el("path").value || undefined,
    ...sshAndSsl(),
  });
  const sshAndSsl = () => {
    const on = el("usessh").checked;
    return {
      ssl: el("ssl").value,
      ssh_host: on ? el("ssh_host").value || undefined : undefined,
      ssh_port: on && el("ssh_port").value ? +el("ssh_port").value : undefined,
      ssh_user: on ? el("ssh_user").value || undefined : undefined,
      ssh_key: on ? el("ssh_key").value || undefined : undefined,
    };
  };
  // ---- tags
  let tags: string[] = [];
  let known: string[] = [...STARTER_TAGS];
  const drawTags = () => {
    q("#tagchips").innerHTML = tags.map((t, i) => `<button type="button" data-rm="${i}" class="inline-flex" title="Remove ${esc(t)}">${tagChip(t)}</button>`).join("");
    q("#tagchips").querySelectorAll<HTMLElement>("[data-rm]").forEach((b) => (b.onclick = () => { tags.splice(+b.dataset.rm!, 1); drawTags(); }));
    const free = known.filter((k) => !tags.some((t) => t.toLowerCase() === k.toLowerCase()));
    q("#tagsug").innerHTML = free.length ? `<span class="text-muted text-[12.5px] mr-0.5">Use:</span>` + free.map((k) => `<button type="button" data-add="${esc(k)}" class="opacity-80 hover:opacity-100">${tagChip(k)}</button>`).join("") : "";
    q("#tagsug").querySelectorAll<HTMLElement>("[data-add]").forEach((b) => (b.onclick = () => { addTag(b.dataset.add!); }));
  };
  const addTag = (raw: string) => {
    const t = raw.trim().replace(/\s+/g, " ").slice(0, 24);
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
    (q("#taginput") as HTMLInputElement).value = "";
    drawTags();
  };
  const tagInput = q<HTMLInputElement>("#taginput");
  tagInput.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(tagInput.value); }
    else if (e.key === "Backspace" && !tagInput.value && tags.length) { tags.pop(); drawTags(); }
  };
  tagInput.onblur = () => { if (tagInput.value.trim()) addTag(tagInput.value); };

  const toProfile = (): Profile => ({
    tags: [...tags],
    id: current?.id ?? "",
    name: el("name").value || kindOf().label,
    kind: el("kind").value,
    host: el("host").value || null,
    port: el("port").value ? +el("port").value : null,
    user: el("user").value || null,
    database: el("database").value || null,
    path: el("path").value || null,
    ssl: el("ssl").value,
    environment: el("environment").value,
    safety: el("safety").value as Profile["safety"],
    color: current?.color ?? null,
    ssh_host: el("usessh").checked ? el("ssh_host").value || null : null,
    ssh_port: el("usessh").checked && el("ssh_port").value ? +el("ssh_port").value : null,
    ssh_user: el("usessh").checked ? el("ssh_user").value || null : null,
    ssh_key: el("usessh").checked ? el("ssh_key").value || null : null,
  });
  el("environment").onchange = () => { el("safety").value = el("environment").value === "production" ? "protected" : "off"; };
  const fill = (p: Profile | null) => {
    current = p;
    tags = [...(p?.tags ?? [])];
    drawTags();
    el("name").value = p?.name ?? "";
    el("kind").value = p?.kind ?? "postgres";
    el("host").value = p?.host ?? "127.0.0.1";
    el("port").value = p?.port ? String(p.port) : "";
    el("user").value = p?.user ?? "";
    el("password").value = "";
    el("database").value = p?.database ?? "";
    el("path").value = p?.path ?? "";
    el("ssl").value = p?.ssl ?? "prefer";
    el("environment").value = p?.environment ?? "local";
    el("safety").value = safetyLevel(p ?? { environment: "local" });
    el("usessh").checked = !!p?.ssh_host;
    el("ssh_host").value = p?.ssh_host ?? "";
    el("ssh_port").value = p?.ssh_port ? String(p.ssh_port) : "";
    el("ssh_user").value = p?.ssh_user ?? "";
    el("ssh_key").value = p?.ssh_key ?? "";
    syncKind();
    msg("");
  };
  const refresh = async () => {
    const list = await api.listConnections();
    known = [...new Set([...list.flatMap((x) => x.tags ?? []), ...STARTER_TAGS])];
    drawTags();
    q("#list").replaceChildren(...list.map((p) => {
      const d = document.createElement("div");
      d.className = "px-2 py-1.5 rounded cursor-default hover:bg-raised " + (p.id === current?.id ? "bg-raised2" : "");
      d.innerHTML = `<div class="truncate">${p.name.replace(/</g, "&lt;")}</div><div class="text-[11px] text-muted">${p.kind}</div>`;
      d.onclick = () => { fill(p); refresh(); };
      d.ondblclick = async () => { fill(p); form.requestSubmit(); };
      return d;
    }));
  };
  const close = () => { overlay.remove(); window.removeEventListener("keydown", onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  window.addEventListener("keydown", onKey, true);

  el("kind").onchange = syncKind;
  el("usessh").onchange = syncKind;
  q("#new").onclick = () => { fill(null); refresh(); };
  q("#close").onclick = close;
  q("#browse").onclick = async () => { const p = await open({ multiple: false }); if (typeof p === "string") el("path").value = p; };
  q("#test").onclick = async () => {
    msg("Testing…");
    try { await api.testConnection(toConfig()); msg("Connection OK"); } catch (e) { msg(String(e), true); }
  };
  q("#save").onclick = async () => {
    try { current = await api.saveConnection(toProfile(), el("password").value || undefined); msg("Saved"); refresh(); } catch (e) { msg(String(e), true); }
  };
  q("#del").onclick = async () => {
    if (!current) return;
    if (!(await confirmDanger({ title: `Delete connection “${current.name}”?`, body: "The saved connection and its stored password are removed. Your databases are not touched.", confirmLabel: "Delete connection" }))) return;
    await api.deleteConnection(current.id); fill(null); refresh();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    msg("Connecting…");
    try {
      // Saved profiles reconnect through the Keychain; unsaved ones connect directly.
      const typedPw = el("password").value;
      current = await api.saveConnection(toProfile(), typedPw || undefined);
      const id = await api.connectSaved(current.id);
      close();
      await onConnect(id, current);
    } catch (err) { msg(String(err), true); }
  };
  fill(null);
  refresh();
}
