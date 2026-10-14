import { invoke } from "@tauri-apps/api/core";

export type Val = { t: "Null" } | { t: "Bool" | "I64" | "F64" | "Text"; v: any } | { t: "Bytes"; v: number[] };
export interface Col { name: string; type_name: string }
export interface Summary { query_id: number; columns: Col[]; row_count: number; truncated: boolean; affected: number | null; elapsed_ms: number }
export interface ObjectRef { schema: string | null; name: string; kind: string }
export interface SchemaTable { schema: string | null; name: string; columns: string[] }
export interface Profile { id: string; name: string; kind: string; host?: string | null; port?: number | null; user?: string | null; database?: string | null; path?: string | null }
export interface ColumnInfo { name: string; type_name: string; nullable: boolean; primary_key: boolean; default: string | null }
export interface ObjectInfo { columns: ColumnInfo[]; indexes: string[]; ddl: string | null }
export interface ConnConfig { kind: string; path?: string; host?: string; port?: number; user?: string; password?: string; database?: string }

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
  selectAllSql: (connId: number, schema: string | null, name: string) => invoke<string>("select_all_sql", { connId, schema, name }),
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
