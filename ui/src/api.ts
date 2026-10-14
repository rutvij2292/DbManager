import { invoke } from "@tauri-apps/api/core";

export type Val = { t: "Null" } | { t: "Bool" | "I64" | "F64" | "Text"; v: any } | { t: "Bytes"; v: number[] };
export interface Col { name: string; type_name: string }
export interface Summary { query_id: number; columns: Col[]; row_count: number; truncated: boolean; affected: number | null; elapsed_ms: number }
export interface ObjectRef { schema: string | null; name: string; kind: string }
export interface SchemaTable { schema: string | null; name: string; columns: string[] }
export interface Profile { id: string; name: string; kind: string; host?: string | null; port?: number | null; user?: string | null; database?: string | null; path?: string | null; ssl?: string | null; ssh_host?: string | null; ssh_port?: number | null; ssh_user?: string | null; ssh_key?: string | null; socket?: string | null; environment?: string | null; color?: string | null; tags?: string[] }
export interface ColumnInfo { name: string; type_name: string; nullable: boolean; primary_key: boolean; default: string | null }
export interface PlanNode { op: string; detail: string; relation: string | null; est_rows: number | null; actual_rows: number | null; cost: number | null; time_ms: number | null; children: PlanNode[] }
export type Change =
  | { kind: "update"; key: [string, Val][]; set: [string, Val][] }
  | { kind: "insert"; set: [string, Val][] }
  | { kind: "delete"; key: [string, Val][] }
export interface IndexInfo { name: string; columns: string[]; unique: boolean; primary: boolean }
export interface ForeignKey { name: string; columns: string[]; ref_schema: string | null; ref_table: string; ref_columns: string[] }
export interface ObjectInfo { columns: ColumnInfo[]; indexes: string[]; ddl: string | null; index_details: IndexInfo[]; foreign_keys: ForeignKey[] }
export type StructChange =
  | { kind: "add_column"; name: string; type_name: string; nullable: boolean; default: string | null }
  | { kind: "drop_column"; name: string }
  | { kind: "rename_column"; from: string; to: string }
  | { kind: "alter_column"; name: string; type_name: string; nullable: boolean; default: string | null; old_type: string; old_nullable: boolean; old_default: string | null }
  | { kind: "create_index"; name: string; columns: string[]; unique: boolean }
  | { kind: "drop_index"; name: string }
export interface ConnConfig { kind: string; path?: string; host?: string; port?: number; user?: string; password?: string; database?: string; ssl?: string; ssh_host?: string; ssh_port?: number; ssh_user?: string; ssh_key?: string }

export const api = {
  connect: (config: ConnConfig) => invoke<number>("connect", { config }),
  disconnect: (connId: number) => invoke<void>("disconnect", { connId }),
  listObjects: (connId: number) => invoke<ObjectRef[]>("list_objects", { connId }),
  describe: (connId: number, schema: string | null, name: string) => invoke<ObjectInfo>("describe", { connId, schema, name }),
  listConnections: () => invoke<Profile[]>("list_connections"),
  saveConnection: (profile: Profile, password?: string) => invoke<Profile>("save_connection", { profile, password }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  testConnection: (config: ConnConfig) => invoke<void>("test_connection", { config }),
  connectSaved: (id: string) => invoke<number>("connect_saved", { id }),
  schemaMap: (connId: number) => invoke<SchemaTable[]>("schema_map", { connId }),
  selectAllSql: (connId: number, schema: string | null, name: string, limit?: number, filter?: string) => invoke<string>("select_all_sql", { connId, schema, name, limit, filter }),
  exportData: (connId: number, sql: string, path: string, options: ExportOptions, job: number) => invoke<number>("export_data", { connId, sql, path, options, job }),
  importPreview: (path: string, hasHeader: boolean, delimiter?: string) => invoke<ImportPreview>("import_preview", { path, hasHeader, delimiter }),
  importData: (connId: number, path: string, options: ImportOptions, job: number) => invoke<{ rows: number; created: boolean }>("import_data", { connId, path, options, job }),
  cancelIo: (job: number) => invoke<void>("cancel_io", { job }),
  explain: (connId: number, sql: string, analyze: boolean) => invoke<PlanNode>("explain", { connId, sql, analyze }),
  applyChanges: (connId: number, schema: string | null, table: string, changes: Change[], preview: boolean) =>
    invoke<string[]>("apply_changes", { connId, schema, table, changes, preview }),
  cancelQuery: (connId: number) => invoke<void>("cancel_query", { connId }),
  applyStructure: (connId: number, schema: string | null, table: string, changes: StructChange[], preview: boolean) =>
    invoke<string[]>("apply_structure", { connId, schema, table, changes, preview }),
  tableplusScan: () => invoke<TpEntry[]>("tableplus_scan"),
  tableplusImport: (ids: string[], passwords: boolean) => invoke<{ imported: number; passwords_copied: number; passwords_missing: number }>("tableplus_import", { ids, passwords }),
  listDatabases: (connId: number) => invoke<string[]>("list_databases", { connId }),
  openDatabase: (connId: number, database: string) => invoke<number>("open_database", { connId, database }),
  switchDatabase: (connId: number, database: string) => invoke<void>("switch_database", { connId, database }),
  erSchema: (connId: number, focus?: string, limit?: number) => invoke<ErSchema>("er_schema", { connId, focus, limit }),
  backupDatabase: (connId: number, path: string, options: BackupOptions, job: number) => invoke<BackupReport>("backup_database", { connId, path, options, job }),
  restoreDatabase: (connId: number, path: string, options: { stop_on_error: boolean }, job: number) => invoke<RestoreReport>("restore_database", { connId, path, options, job }),
  runQuery: (connId: number, sql: string) => invoke<Summary>("run_query", { connId, sql }),
  getRows: (queryId: number, offset: number, limit: number) => invoke<Val[][]>("get_rows", { queryId, offset, limit }),
  release: (queryId: number) => invoke<void>("release_query", { queryId }),
};

export function show(v: Val): string {
  switch (v.t) {
    case "Null": return "NULL";
    case "Bytes": return `<${v.v.length} bytes>`;
    default: return String(v.v);
  }
}

export type ExportFormat = "csv" | "tsv" | "json" | "jsonl" | "sql";
export interface ExportOptions { format: ExportFormat; header: boolean; delimiter?: string; table?: string; batch_rows?: number }
export interface ImportPreview { headers: string[]; sample: (string | null)[][]; types: ("integer" | "real" | "text")[]; delimiter: string; format: string }
export interface ImportOptions { schema: string | null; table: string; create: boolean; has_header: boolean; delimiter?: string; mapping: (string | null)[]; empty_as_null: boolean }

export interface TpEntry { id: string; name: string; kind: string | null; driver: string; host?: string | null; port?: number | null; user?: string | null; database?: string | null; path?: string | null; socket?: string | null; ssh_host?: string | null; environment?: string | null; already_imported: boolean }

export interface ErColumn { name: string; type_name: string; primary_key: boolean; nullable: boolean; foreign_key: boolean }
export interface ErTable { id: string; schema: string | null; name: string; columns: ErColumn[] }
export interface ErRelation { name: string; from_table: string; from_columns: string[]; to_table: string; to_columns: string[] }
export interface ErSchema { tables: ErTable[]; relations: ErRelation[]; truncated: boolean; total_tables: number }

export interface BackupOptions { tables: { schema: string | null; name: string }[] | null; structure: boolean; data: boolean; views: boolean; gzip: boolean; add_drop: boolean }
export interface BackupReport { tables: number; rows: number; bytes: number }
export interface RestoreReport { statements: number; copied_rows: number; failed: number; errors: [string, string][] }
