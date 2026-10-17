import { confirmDanger, safetyLevel } from "./dbadmin";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type ConnConfig, type Profile } from "./api";
import { esc, tagChip, STARTER_TAGS, modal } from "./ui";
import { icon, engineBadge, envColor } from "./icons";

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

const field = "field w-full";
const cap = "text-[11px] font-semibold uppercase tracking-wide text-muted pt-1";
const lab = (t: string, inner: string, cls = "", title = "") => `<label class="flex flex-col gap-1 ${cls}"${title ? ` title="${title}"` : ""}><span class="text-[12px] text-soft">${t}</span>${inner}</label>`;

/** Connection manager modal: saved list on the left, form on the right. */
export function showConnectionManager(onConnect: (connId: number, p: Profile) => Promise<void>) {
  const m = modal(`
    <div class="flex" style="height:min(620px,80vh)">
      <div class="w-[240px] shrink-0 border-r border-line flex flex-col">
        <button id="new" class="btn btn-ghost m-2">${icon("plus", 14)}<span>New connection</span></button>
        <div id="list" class="flex-1 overflow-auto pb-1.5"></div>
      </div>
      <form id="form" class="flex-1 flex flex-col min-w-0">
        <div class="flex-1 overflow-auto px-5 py-4 flex flex-col gap-3">
          <div class="${cap}" style="padding-top:0">General</div>
          ${lab("Name", `<input name="name" class="${field}" placeholder="Local Postgres"/>`)}
          <div>
            <div class="mb-1 text-[12px] text-soft">Tags <span class="text-muted">· group connections, e.g. Work or Practice</span></div>
            <div id="tagbox" class="${field} flex flex-wrap items-center gap-1.5" style="height:auto;min-height:32px;padding-top:4px;padding-bottom:4px">
              <span id="tagchips" class="contents"></span>
              <input id="taginput" class="flex-1 min-w-[120px] bg-transparent outline-none" style="height:22px" placeholder="Add a tag, then press Enter"/>
            </div>
            <div id="tagsug" class="flex flex-wrap gap-1.5 mt-1.5"></div>
          </div>
          <div class="flex gap-3">
            ${lab("Environment", `<select name="environment" class="${field}"><option value="local">Local</option><option value="staging">Staging</option><option value="production">Production</option></select>`, "w-44")}
            ${lab("Safety", `<select name="safety" class="${field}"><option value="off">Off</option><option value="protected">Protected</option><option value="readonly">Read-only</option></select>`, "flex-1", "Protected: truncate/drop are blocked and every write asks first. Read-only: nothing can be changed.")}
          </div>
          <div class="${cap}">Connection</div>
          ${lab("Type", `<select name="kind" class="${field}">${KINDS.map((k) => `<option value="${k.id}">${k.label}</option>`).join("")}</select>`)}
          <div id="net" class="flex flex-col gap-3">
            <div class="${cap}">Server</div>
            <div class="flex gap-3">${lab("Host", `<input name="host" class="${field}" value="127.0.0.1"/>`, "flex-1")}${lab("Port", `<input name="port" type="number" class="${field}"/>`, "w-24")}</div>
            <div class="flex gap-3">${lab("User", `<input name="user" class="${field}"/>`, "flex-1")}${lab("Password", `<input name="password" type="password" class="${field}" placeholder="(stored in Keychain)"/>`, "flex-1")}</div>
            <div class="flex gap-3">${lab("Database", `<input name="database" class="${field}"/>`, "flex-1")}${lab("SSL", `<select name="ssl" class="${field}"><option value="prefer">Prefer</option><option value="disable">Off</option><option value="require">Require</option><option value="verify">Verify certificate</option></select>`, "w-44")}</div>
            <label class="flex items-center gap-2"><input type="checkbox" name="usessh"/> Connect over SSH (uses your ssh keys / agent)</label>
            <div id="ssh" class="hidden flex flex-col gap-3">
              <div class="flex gap-3">${lab("SSH host", `<input name="ssh_host" class="${field}"/>`, "flex-1")}${lab("Port", `<input name="ssh_port" type="number" class="${field}" placeholder="22"/>`, "w-20")}${lab("User", `<input name="ssh_user" class="${field}"/>`, "w-32")}</div>
              ${lab("Private key (optional)", `<input name="ssh_key" class="${field}" placeholder="~/.ssh/id_ed25519"/>`)}
            </div>
          </div>
          <div id="file" class="hidden flex flex-col gap-3">
            <div class="${cap}">File</div>
            <div class="flex gap-2 items-end">${lab("Path", `<input name="path" class="${field}"/>`, "flex-1")}<button type="button" id="browse" class="btn">Browse…</button></div>
          </div>
        </div>
        <div class="px-5 py-3 border-t border-line flex items-center gap-2">
          <button type="button" id="del" class="btn btn-ghost text-danger">Delete</button>
          <div id="msg" class="text-[12px] truncate flex-1 min-w-0 mr-1"></div>
          <button type="button" id="close" class="btn btn-ghost">Close</button>
          <button type="button" id="test" class="btn btn-ghost">Test</button>
          <button type="button" id="save" class="btn">Save</button>
          <button type="submit" class="btn btn-primary">Connect</button>
        </div>
      </form>
    </div>`, 800, { backdropClose: false });
  const q = m.q;
  const form = q<HTMLFormElement>("#form");
  const el = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const msg = (t: string, bad = false) => { const e = q("#msg"); e.textContent = t; e.title = t; e.className = "text-[12px] truncate flex-1 min-w-0 mr-1 " + (bad ? "text-danger" : "text-ok"); };
  let current: Profile | null = null;
  const syncDel = () => { q("#del").style.visibility = current ? "" : "hidden"; };

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
    q("#tagsug").innerHTML = free.length ? `<span class="text-muted text-[12px] mr-0.5">Use:</span>` + free.map((k) => `<button type="button" data-add="${esc(k)}" class="opacity-80 hover:opacity-100">${tagChip(k)}</button>`).join("") : "";
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
    syncDel();
    msg("");
  };
  const refresh = async () => {
    const list = await api.listConnections();
    known = [...new Set([...list.flatMap((x) => x.tags ?? []), ...STARTER_TAGS])];
    drawTags();
    q("#list").replaceChildren(...list.map((p) => {
      const d = document.createElement("div");
      d.className = "flex items-center gap-2.5 px-2.5 h-11 rounded-lg mx-1.5 cursor-default " + (p.id === current?.id ? "bg-accent-soft" : "hover:bg-raised");
      if (p.environment && p.environment !== "local") d.style.boxShadow = `inset 3px 0 0 ${envColor(p.environment)}`;
      const sub = p.kind === "sqlite" ? p.path ?? "" : [p.host, p.port].filter(Boolean).join(":");
      d.innerHTML = `${engineBadge(p.kind, 22)}<div class="min-w-0 flex-1"><div class="text-[13px] truncate">${esc(p.name)}</div><div class="text-[12px] text-muted mono truncate">${esc(sub)}</div></div>`;
      d.onclick = () => { fill(p); refresh(); };
      d.ondblclick = async () => { fill(p); form.requestSubmit(); };
      return d;
    }));
  };
  const close = m.close;

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
    try { current = await api.saveConnection(toProfile(), el("password").value || undefined); syncDel(); msg("Saved"); refresh(); } catch (e) { msg(String(e), true); }
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
