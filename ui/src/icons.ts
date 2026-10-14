/** Small stroke icon set (16px grid, currentColor). */
const P: Record<string, string> = {
  star: '<path d="M8 2.2 9.8 6l4.1.5-3 2.9.8 4.1L8 11.5 4.3 13.5l.8-4.1-3-2.9L6.2 6 8 2.2Z"/>',
  table: '<rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M2 6.5h12M6.5 6.5V13"/>',
  view: '<path d="M1.8 8s2.2-4 6.2-4 6.2 4 6.2 4-2.2 4-6.2 4S1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="1.7"/>',
  key: '<circle cx="5.2" cy="10.8" r="2.6"/><path d="m7.1 9 5.6-5.6M10.6 5.5l1.6 1.6M12 4.1l1.4 1.4"/>',
  collection: '<path d="M2.5 5.2 8 2.5l5.5 2.7L8 8 2.5 5.2Z"/><path d="m2.5 8 5.5 2.7L13.5 8M2.5 10.8 8 13.5l5.5-2.7"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  chevron: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  chevronDown: '<path d="m3.5 6 4.5 4.5L12.5 6"/>',
  play: '<path d="M4.5 3.2v9.6L12.8 8 4.5 3.2Z" fill="currentColor"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.4" fill="currentColor"/>',
  plan: '<path d="M3 3.5h4M3 8h7M3 12.5h10"/><circle cx="11.5" cy="3.5" r="1.4"/>',
  wand: '<path d="m3 13 7.5-7.5M9 3.5l.6 1.2 1.2.6-1.2.6L9 7.1l-.6-1.2-1.2-.6 1.2-.6L9 3.5ZM12.5 8.5l.4.8.8.4-.8.4-.4.8-.4-.8-.8-.4.8-.4.4-.8Z"/>',
  blocks: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><path d="M11.2 9v4.5M9 11.2h4.5"/>',
  download: '<path d="M8 2.5v7.5m-3-3 3 3 3-3M3 13h10"/>',
  upload: '<path d="M8 10V2.5m-3 3 3-3 3 3M3 13h10"/>',
  sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1"/>',
  moon: '<path d="M13 9.6A5.4 5.4 0 0 1 6.4 3 5.4 5.4 0 1 0 13 9.6Z"/>',
  plug: '<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.2a3.5 3.5 0 0 1-7 0V5.5ZM8 11.2v2.3"/>',
  database: '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
  structure: '<path d="M3 3.5h10M3 8h10M3 12.5h6"/><circle cx="12" cy="12.5" r="1.2"/>',
  commit: '<path d="m3.5 8.5 3 3 6-7"/>',
  undo: '<path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5H9a4 4 0 0 1 0 8H6"/>',
  sparkle: '<path d="M8 2.5 9.4 6.6 13.5 8 9.4 9.4 8 13.5 6.6 9.4 2.5 8l4.1-1.4L8 2.5Z"/>',
  ssh: '<rect x="3" y="7" width="10" height="6.5" rx="1.6"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  filter: '<path d="M2.5 3.5h11L9.3 8.5v4l-2.6 1.2V8.5L2.5 3.5Z"/>',
  diagram: '<rect x="1.8" y="2.5" width="5" height="4" rx="1"/><rect x="9.2" y="9.5" width="5" height="4" rx="1"/><rect x="9.2" y="2.5" width="5" height="4" rx="1"/><path d="M6.8 4.5h2.4M4.3 6.5v5h4.9"/>',
  archive: '<rect x="2" y="2.8" width="12" height="3.4" rx="1"/><path d="M3 6.2v6.3c0 .7.5 1.2 1.2 1.2h7.6c.7 0 1.2-.5 1.2-1.2V6.2M6.5 9h3"/>',
  restore: '<path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1M2.5 2.5v3h3"/><path d="M8 5v3.2l2 1.2"/>',
  warn: '<path d="M8 2.5 14 13H2L8 2.5ZM8 6.5v3M8 11.2v.1"/>',
};

export function icon(name: keyof typeof P | string, size = 16, cls = "", filled = false): string {
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ""}</svg>`;
}

/** Engine identity: a two-letter glyph on the engine's own hue (tokens, so it adapts to light and dark). */
const ENGINES: Record<string, { label: string; hue: string }> = {
  postgres: { label: "Pg", hue: "--eng-pg" }, cockroach: { label: "Cr", hue: "--eng-mssql" }, redshift: { label: "Rs", hue: "--eng-mssql" }, greenplum: { label: "Gp", hue: "--eng-mongo" },
  mysql: { label: "My", hue: "--eng-my" }, mariadb: { label: "Ma", hue: "--eng-maria" }, sqlite: { label: "Sq", hue: "--eng-sqlite" },
  mssql: { label: "Ms", hue: "--eng-mssql" }, redis: { label: "Rd", hue: "--eng-redis" }, mongo: { label: "Mg", hue: "--eng-mongo" },
};
/** CSS value for an engine's hue, e.g. `var(--eng-pg)`. */
export function engineVar(kind: string | null | undefined): string {
  return `var(${(kind && ENGINES[kind]?.hue) || "--muted"})`;
}
export function engineBadge(kind: string | null | undefined, size = 30): string {
  const e = (kind && ENGINES[kind]) || { label: "··", hue: "--muted" };
  return `<span class="glyph" style="--hue:var(${e.hue});width:${size}px;height:${size}px;border-radius:${Math.round(size / 3.6)}px;font-size:${Math.round(size * 0.4)}px;letter-spacing:-.01em">${e.label}</span>`;
}

export const ENGINE_NAMES: Record<string, string> = {
  postgres: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB", sqlite: "SQLite", mssql: "SQL Server", redis: "Redis", mongo: "MongoDB",
  cockroach: "CockroachDB", redshift: "Redshift", greenplum: "Greenplum",
};

export function envColor(env: string | null | undefined): string {
  return env === "production" ? "var(--env-production)" : env === "staging" ? "var(--env-staging)" : "var(--env-local)";
}
/** Rose for production, amber for staging; local gets no chrome of its own. */
export const isCareful = (env: string | null | undefined) => env === "production" || env === "staging";
