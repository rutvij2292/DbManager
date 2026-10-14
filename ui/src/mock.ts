/**
 * Dev-only stand-in for the Tauri backend so the UI can be rendered in a plain browser
 * (e.g. for screenshots). Loaded only when `?mock` is in the URL during `vite dev`.
 */
const T = (v: string) => ({ t: "Text", v }), I = (v: number) => ({ t: "I64", v }), F = (v: number) => ({ t: "F64", v }), N = { t: "Null" };

const profiles = [
  { id: "p1", name: "Shop – local", kind: "mysql", host: "127.0.0.1", port: 3306, user: "root", database: null, environment: "local", color: null },
  { id: "p2", name: "Analytics warehouse", kind: "postgres", host: "db.analytics.internal", port: 5432, user: "analyst", database: "warehouse", environment: "staging", color: null, ssh_host: "bastion.example.com" },
  { id: "p3", name: "Billing – production", kind: "postgres", host: "billing-primary.example.com", port: 5432, user: "app_ro", database: "billing", environment: "production", color: null },
  { id: "p4", name: "Session cache", kind: "redis", host: "127.0.0.1", port: 6379, environment: "local", color: null },
  { id: "p5", name: "notes.sqlite", kind: "sqlite", path: "/Users/dev/notes.sqlite", environment: "local", color: null },
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

let currentDb: string | null = null;
const handlers: Record<string, (a: any) => unknown> = {
  list_connections: () => profiles,
  connect_saved: (a) => { currentDb = profiles.find((p) => p.id === a.id)?.database ?? null; return 1; },
  list_databases: () => ["analytics", "information_schema", "mysql", "performance_schema", "shop", "shop_staging", "sys"],
  switch_database: (a) => { currentDb = a.database; return null; },
  connect: () => 1,
  test_connection: () => null,
  list_objects: () => (currentDb === "shop" ? tables.map(({ schema, name, kind }) => ({ schema, name, kind })) : []),
  schema_map: () => (currentDb !== "shop" ? [] : tables).map(({ schema, name, columns }) => ({ schema, name, columns })),
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
};

export function installMock() {
  (window as any).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: any) => {
      if (cmd.startsWith("plugin:event|")) return 0;
      const h = handlers[cmd];
      if (!h) throw new Error(`mock: no handler for ${cmd}`);
      return h(args ?? {});
    },
    transformCallback: () => 0,
    unregisterCallback: () => {},
    convertFileSrc: (p: string) => p,
  };
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}
