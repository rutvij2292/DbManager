/**
 * Dev-only stand-in for the Tauri backend so the UI can be rendered in a plain browser
 * (e.g. for screenshots). Loaded only when `?mock` is in the URL during `vite dev`.
 */
const T = (v: string) => ({ t: "Text", v }), I = (v: number) => ({ t: "I64", v }), F = (v: number) => ({ t: "F64", v }), N = { t: "Null" };

const profiles = [
  { id: "p1", name: "Shop – local", kind: "mysql", host: "127.0.0.1", port: 3306, user: "root", database: null, environment: "local", color: null, tags: ["Practice"] },
  { id: "p2", name: "Analytics warehouse", kind: "postgres", host: "db.analytics.internal", port: 5432, user: "analyst", database: "warehouse", environment: "staging", color: null, ssh_host: "bastion.example.com", tags: ["Work"] },
  { id: "p3", name: "Billing – production", kind: "postgres", host: "billing-primary.example.com", port: 5432, user: "app_ro", database: "billing", environment: "production", color: null, tags: ["Work", "Clients"] },
  { id: "p4", name: "Session cache", kind: "redis", host: "127.0.0.1", port: 6379, environment: "local", color: null, tags: ["Projects"] },
  { id: "p5", name: "notes.sqlite", kind: "sqlite", path: "/Users/dev/notes.sqlite", environment: "local", color: null, tags: ["Practice", "Projects"] },
];

const tables = [
  { schema: null, name: "customers", kind: "table", columns: ["id", "name", "email", "country", "created_at"] },
  { schema: null, name: "order_items", kind: "table", columns: ["id", "order_id", "product_id", "quantity", "unit_price"] },
  { schema: null, name: "orders", kind: "table", columns: ["id", "customer_id", "status", "total", "placed_at", "shipped"] },
  { schema: null, name: "products", kind: "table", columns: ["id", "sku", "title", "price", "stock"] },
  { schema: null, name: "revenue_by_month", kind: "view", columns: ["month", "revenue"] },
];

const cols = ["id", "customer_id", "status", "total", "placed_at", "shipped"];
const names = ["Ada Lovelace", "Grace Hopper", "Linus Torvalds", "Margaret Hamilton", "Alan Turing", "Barbara Liskov", "Dennis Ritchie", "Edsger Dijkstra"];
const status = ["paid", "pending", "shipped", "refunded"];
const rows = Array.from({ length: 5000 }, (_, i) => [I(i + 1), I(1 + (i * 7) % 8), T(status[i % 4]), F(Math.round((20 + ((i * 37) % 480)) * 100) / 100), T(`2026-0${1 + (i % 9)}-${10 + (i % 18)} 1${i % 10}:2${i % 6}:00`), i % 3 === 0 ? N : { t: "Bool", v: i % 2 === 0 }]);

// Several connections at once: each backend id remembers its profile and database.
let nextId = 1;
const dbOf = new Map<number, string | null>();
const profOf = new Map<number, string>();
const dbTables: Record<string, string[]> = {
  shop: ["customers", "order_items", "orders", "products", "revenue_by_month"],
  shop_staging: ["customers", "orders", "products"],
  analytics: ["events", "sessions", "page_views"],
  warehouse: ["fact_sales", "dim_customer", "dim_product", "dim_date"],
  billing: ["invoices", "payments", "subscriptions", "plans"],
  "notes.sqlite": ["notes", "tags"],
};
const objectsOf = (db: string | null) => (db && dbTables[db] ? dbTables[db] : []).map((name) => ({ schema: null, name, kind: name === "revenue_by_month" ? "view" : "table" }));
const col = (name: string, type: string, pk = false, fk = false, nullable = true) => ({ name, type_name: type, primary_key: pk, foreign_key: fk, nullable });
const er = {
  tables: [
    { id: "countries", schema: null, name: "countries", columns: [col("id", "int", true), col("iso_code", "char(2)"), col("name", "varchar(80)")] },
    { id: "customers", schema: null, name: "customers", columns: [col("id", "int", true), col("country_id", "int", false, true), col("name", "varchar(120)"), col("email", "varchar(190)"), col("created_at", "datetime")] },
    { id: "addresses", schema: null, name: "addresses", columns: [col("id", "int", true), col("customer_id", "int", false, true, false), col("line1", "varchar(160)"), col("city", "varchar(80)"), col("postcode", "varchar(16)")] },
    { id: "orders", schema: null, name: "orders", columns: [col("id", "int", true), col("customer_id", "int", false, true, false), col("status", "varchar(20)"), col("total", "decimal(10,2)"), col("placed_at", "datetime"), col("shipped", "tinyint(1)")] },
    { id: "order_items", schema: null, name: "order_items", columns: [col("id", "int", true), col("order_id", "int", false, true, false), col("product_id", "int", false, true, false), col("quantity", "int"), col("unit_price", "decimal(10,2)")] },
    { id: "payments", schema: null, name: "payments", columns: [col("id", "int", true), col("order_id", "int", false, true, false), col("amount", "decimal(10,2)"), col("provider", "varchar(30)"), col("paid_at", "datetime")] },
    { id: "products", schema: null, name: "products", columns: [col("id", "int", true), col("category_id", "int", false, true), col("sku", "varchar(40)"), col("title", "varchar(200)"), col("price", "decimal(10,2)"), col("stock", "int")] },
    { id: "categories", schema: null, name: "categories", columns: [col("id", "int", true), col("parent_id", "int", false, true), col("name", "varchar(80)")] },
    { id: "reviews", schema: null, name: "reviews", columns: [col("id", "int", true), col("product_id", "int", false, true, false), col("customer_id", "int", false, true, false), col("rating", "tinyint"), col("body", "text")] },
    { id: "audit_log", schema: null, name: "audit_log", columns: [col("id", "bigint", true), col("actor", "varchar(80)"), col("action", "varchar(80)"), col("at", "datetime")] },
    { id: "settings", schema: null, name: "settings", columns: [col("key", "varchar(80)", true), col("value", "text")] },
  ],
  relations: [
    ["fk_cust_country", "customers", "country_id", "countries"], ["fk_addr_cust", "addresses", "customer_id", "customers"], ["fk_order_cust", "orders", "customer_id", "customers"],
    ["fk_item_order", "order_items", "order_id", "orders"], ["fk_item_prod", "order_items", "product_id", "products"], ["fk_pay_order", "payments", "order_id", "orders"],
    ["fk_prod_cat", "products", "category_id", "categories"], ["fk_cat_parent", "categories", "parent_id", "categories"], ["fk_rev_prod", "reviews", "product_id", "products"], ["fk_rev_cust", "reviews", "customer_id", "customers"],
  ].map(([name, from, fc, to]) => ({ name, from_table: from, from_columns: [fc], to_table: to, to_columns: ["id"] })),
  truncated: false, total_tables: 11,
};
// Tiny event bus so progress dialogs can be shown mid-way.
const callbacks = new Map<number, (e: unknown) => void>();
const listeners = new Map<string, number[]>();
let cbId = 1;
const emit = (event: string, payload: unknown) => (listeners.get(event) ?? []).forEach((id) => callbacks.get(id)?.({ event, id, payload }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fakeJob(job: number, total: number, steps = 24, ms = 110) {
  for (let i = 1; i <= steps; i++) { await sleep(ms); emit("io-progress", { job, rows: Math.round((total * i) / steps) }); }
  return total;
}
const handlers: Record<string, (a: any) => unknown> = {
  "plugin:dialog|open": () => "/Users/dev/Downloads/customers_2026.csv",
  "plugin:dialog|save": () => "/Users/dev/Documents/orders_2026-10-14.csv",
  export_data: async (a) => fakeJob(a.job, 1_240_000),
  import_preview: () => ({ headers: ["id", "name", "email", "country", "signup_date", "lifetime_value", "notes"], types: ["integer", "text", "text", "text", "text", "real", "text"], delimiter: ",", format: "delimited",
    sample: [["1", "Ada Lovelace", "ada@example.com", "UK", "2024-03-02", "1280.50", "Early adopter"], ["2", "Grace Hopper", "grace@example.com", "US", "2024-03-09", "940.00", null], ["3", "Linus T.", "linus@example.com", "FI", "2024-04-11", "55.25", "Asked for a refund"]] }),
  import_data: async (a) => ({ rows: await fakeJob(a.job, 482_000), created: !!a.options?.create }),
  er_schema: (a) => {
    if (!a.focus) return er;
    const keep = new Set([a.focus]);
    er.relations.forEach((r) => { if (r.from_table === a.focus) keep.add(r.to_table); if (r.to_table === a.focus) keep.add(r.from_table); });
    return { ...er, tables: er.tables.filter((t) => keep.has(t.id)), relations: er.relations.filter((r) => keep.has(r.from_table) && keep.has(r.to_table)) };
  },
  list_connections: () => profiles,
  connect_saved: (a) => { const id = nextId++; dbOf.set(id, profiles.find((p) => p.id === a.id)?.database ?? null); profOf.set(id, a.id); return id; },
  open_database: (a) => { const id = nextId++; dbOf.set(id, a.database); profOf.set(id, profOf.get(a.connId) ?? ""); return id; },
  list_databases: (a) => { const k = profiles.find((p) => p.id === profOf.get(a.connId))?.kind; return k === "mysql" ? ["analytics", "information_schema", "mysql", "performance_schema", "shop", "shop_staging", "sys"] : k === "postgres" ? ["billing", "postgres", "warehouse"] : []; },
  switch_database: () => null,
  connect: () => 1,
  test_connection: () => null,
  list_objects: (a) => objectsOf(dbOf.get(a.connId) ?? (profiles.find((p) => p.id === profOf.get(a.connId))?.kind === "sqlite" ? "notes.sqlite" : null)),
  schema_map: (a) => objectsOf(dbOf.get(a.connId) ?? null).map((o) => ({ schema: null, name: o.name, columns: tables.find((t) => t.name === o.name)?.columns ?? ["id", "name"] })),
  describe: (a) => {
    const t = tables.find((x) => x.name === a.name) ?? tables[0];
    return {
      columns: t.columns.map((c, i) => ({ name: c, type_name: c === "id" || c.endsWith("_id") ? "int" : c.includes("at") ? "datetime" : c === "total" || c === "price" ? "decimal(10,2)" : c === "shipped" ? "tinyint(1)" : "varchar(255)", nullable: i > 0 && c !== "customer_id", primary_key: i === 0, default: null })),
      indexes: ["PRIMARY"], ddl: null,
      index_details: [{ name: "PRIMARY", columns: ["id"], unique: true, primary: true }, { name: "idx_customer", columns: ["customer_id"], unique: false, primary: false }],
      foreign_keys: t.name === "orders" ? [{ name: "fk_customer", columns: ["customer_id"], ref_schema: null, ref_table: "customers", ref_columns: ["id"] }] : [],
    };
  },
  select_all_sql: (a) => `SELECT * FROM \`${a.name}\` LIMIT 1000`,
  run_query: () => ({ query_id: 1, columns: cols.map((name) => ({ name, type_name: name === "id" || name === "customer_id" ? "int" : name === "total" ? "decimal" : name === "placed_at" ? "datetime" : "varchar" })), row_count: rows.length, truncated: false, affected: null, elapsed_ms: 4 }),
  get_rows: (a) => rows.slice(a.offset, a.offset + a.limit),
  release_query: () => null,
  explain: () => ({ op: "Query", detail: "", relation: null, est_rows: null, actual_rows: null, cost: null, time_ms: null, children: [
    { op: "Hash Join", detail: "Hash Cond: orders.customer_id = customers.id", relation: null, est_rows: 4800, actual_rows: 5000, cost: 410.2, time_ms: 18.4, children: [
      { op: "Seq Scan", detail: "Filter: status = 'paid'", relation: "orders", est_rows: 5000, actual_rows: 1250, cost: 288.0, time_ms: 11.2, children: [] },
      { op: "Index Scan", detail: "Index Name: customers_pkey", relation: "customers", est_rows: 8, actual_rows: 8, cost: 1.2, time_ms: 0.1, children: [] }] }] }),
  tableplus_scan: () => [
    { id: "t1", name: "Local MySQL", kind: "mysql", driver: "MySQL", host: "127.0.0.1", port: 3306, user: "root", environment: "local", already_imported: false },
    { id: "t2", name: "Staging replica", kind: "postgres", driver: "PostgreSQL", host: "stg-replica.example.com", port: 5432, user: "app", ssh_host: "bastion.example.com", environment: "staging", already_imported: false },
    { id: "t3", name: "Production – read only", kind: "mysql", driver: "MariaDB", host: "10.0.4.12", port: 3306, user: "readonly", environment: "production", already_imported: true },
    { id: "t4", name: "Data lake", kind: null, driver: "Snowflake", environment: "production", already_imported: false },
  ],
  tableplus_import: () => ({ imported: 3, passwords_copied: 2, passwords_missing: 1 }),
  save_connection: (a) => a.profile,
  delete_connection: () => null,
  cancel_query: () => null,
  backup_database: () => ({ tables: 4, rows: 12840, bytes: 2_400_000 }),
  restore_database: () => ({ statements: 120, copied_rows: 0, failed: 0, errors: [] }),
};

export function installMock() {
  (window as any).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: any) => {
      if (cmd === "plugin:event|listen") { const l = listeners.get(args.event) ?? []; l.push(args.handler); listeners.set(args.event, l); return args.handler; }
      if (cmd.startsWith("plugin:event|")) return 0;
      const h = handlers[cmd];
      if (!h) throw new Error(`mock: no handler for ${cmd}`);
      return h(args ?? {});
    },
    transformCallback: (cb: (e: unknown) => void) => { const id = cbId++; callbacks.set(id, cb); return id; },
    unregisterCallback: () => {},
    convertFileSrc: (p: string) => p,
  };
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}
