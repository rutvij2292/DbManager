#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use dbcore::{ColumnMeta, ConnConfig, Connection, Driver, ObjectInfo, ObjectRef, PlanNode, QueryResult, SchemaTable, Value};
use driver_mysql::MysqlDriver;
use driver_postgres::PostgresDriver;
use driver_sqlite::SqliteDriver;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{Manager, State};

/// Hard cap on rows kept per result (the UI pages through them).
const MAX_ROWS: usize = 200_000;

#[derive(Default)]
struct AppState {
    next_id: AtomicU64,
    conns: Mutex<HashMap<u64, Arc<dyn Connection>>>,
    results: Mutex<HashMap<u64, QueryResult>>,
}

impl AppState {
    fn id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }
    fn conn(&self, id: u64) -> Result<Arc<dyn Connection>, String> {
        self.conns.lock().unwrap().get(&id).cloned().ok_or_else(|| "not connected".to_string())
    }
}

#[derive(Serialize)]
struct QuerySummary {
    query_id: u64,
    columns: Vec<ColumnMeta>,
    row_count: usize,
    truncated: bool,
    affected: Option<u64>,
    elapsed_ms: u128,
}

async fn open_conn(config: &ConnConfig) -> Result<Arc<dyn Connection>, String> {
    let conn = match config.kind.as_str() {
        "sqlite" => SqliteDriver.connect(config).await,
        // CockroachDB, Redshift and Greenplum speak the Postgres wire protocol.
        "postgres" | "cockroach" | "redshift" | "greenplum" => PostgresDriver.connect(config).await,
        // MariaDB speaks the MySQL wire protocol.
        "mysql" | "mariadb" => MysqlDriver.connect(config).await,
        k => return Err(format!("driver '{k}' is not implemented yet")),
    }
    .map_err(|e| e.to_string())?;
    conn.ping().await.map_err(|e| e.to_string())?;
    Ok(conn)
}

#[derive(Serialize, Deserialize, Clone)]
struct Profile {
    id: String,
    name: String,
    kind: String,
    host: Option<String>,
    port: Option<u16>,
    user: Option<String>,
    database: Option<String>,
    path: Option<String>,
}

fn profiles_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("connections.json"))
}

fn read_profiles(app: &tauri::AppHandle) -> Result<Vec<Profile>, String> {
    let p = profiles_path(app)?;
    Ok(std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
}

fn keychain(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("dev.rutvij.lattice", id).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_connections(app: tauri::AppHandle) -> Result<Vec<Profile>, String> {
    read_profiles(&app)
}

#[tauri::command]
fn save_connection(app: tauri::AppHandle, mut profile: Profile, password: Option<String>) -> Result<Profile, String> {
    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    let mut all = read_profiles(&app)?;
    all.retain(|p| p.id != profile.id);
    all.push(profile.clone());
    std::fs::write(profiles_path(&app)?, serde_json::to_string_pretty(&all).unwrap()).map_err(|e| e.to_string())?;
    if let Some(pw) = password {
        keychain(&profile.id)?.set_password(&pw).map_err(|e| e.to_string())?;
    }
    Ok(profile)
}

#[tauri::command]
fn delete_connection(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut all = read_profiles(&app)?;
    all.retain(|p| p.id != id);
    std::fs::write(profiles_path(&app)?, serde_json::to_string_pretty(&all).unwrap()).map_err(|e| e.to_string())?;
    let _ = keychain(&id).and_then(|e| e.delete_credential().map_err(|e| e.to_string()));
    Ok(())
}

/// Connect without saving, to verify credentials.
#[tauri::command]
async fn test_connection(config: ConnConfig) -> Result<(), String> {
    open_conn(&config).await.map(|_| ())
}

#[tauri::command]
async fn connect_saved(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<u64, String> {
    let p = read_profiles(&app)?.into_iter().find(|p| p.id == id).ok_or("connection not found")?;
    let password = keychain(&id).ok().and_then(|e| e.get_password().ok());
    let config = ConnConfig { kind: p.kind, path: p.path, host: p.host, port: p.port, user: p.user, password, database: p.database };
    let conn = open_conn(&config).await?;
    let cid = state.id();
    state.conns.lock().unwrap().insert(cid, conn);
    Ok(cid)
}

#[tauri::command]
async fn schema_map(state: State<'_, AppState>, conn_id: u64) -> Result<Vec<SchemaTable>, String> {
    state.conn(conn_id)?.schema_map().await.map_err(|e| e.to_string())
}

#[tauri::command]
fn select_all_sql(state: State<'_, AppState>, conn_id: u64, schema: Option<String>, name: String) -> Result<String, String> {
    Ok(state.conn(conn_id)?.select_all(schema.as_deref(), &name, 1000))
}

#[tauri::command]
async fn connect(state: State<'_, AppState>, config: ConnConfig) -> Result<u64, String> {
    let conn = open_conn(&config).await?;
    let id = state.id();
    state.conns.lock().unwrap().insert(id, conn);
    Ok(id)
}

#[tauri::command]
fn disconnect(state: State<'_, AppState>, conn_id: u64) {
    state.conns.lock().unwrap().remove(&conn_id);
}

#[tauri::command]
async fn list_objects(state: State<'_, AppState>, conn_id: u64) -> Result<Vec<ObjectRef>, String> {
    state.conn(conn_id)?.objects().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn describe(state: State<'_, AppState>, conn_id: u64, schema: Option<String>, name: String) -> Result<ObjectInfo, String> {
    state.conn(conn_id)?.describe(schema.as_deref(), &name).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_query(state: State<'_, AppState>, conn_id: u64, sql: String) -> Result<QuerySummary, String> {
    let mut r = state.conn(conn_id)?.query(&sql).await.map_err(|e| e.to_string())?;
    let truncated = r.rows.len() > MAX_ROWS;
    r.rows.truncate(MAX_ROWS);
    let query_id = state.id();
    let summary = QuerySummary {
        query_id,
        columns: r.columns.clone(),
        row_count: r.rows.len(),
        truncated,
        affected: r.affected,
        elapsed_ms: r.elapsed_ms,
    };
    state.results.lock().unwrap().insert(query_id, r);
    Ok(summary)
}

#[tauri::command]
async fn explain(state: State<'_, AppState>, conn_id: u64, sql: String, analyze: bool) -> Result<PlanNode, String> {
    state.conn(conn_id)?.explain(&sql, analyze).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn get_rows(state: State<'_, AppState>, query_id: u64, offset: usize, limit: usize) -> Result<Vec<Vec<Value>>, String> {
    let results = state.results.lock().unwrap();
    let r = results.get(&query_id).ok_or("result expired")?;
    let end = (offset + limit).min(r.rows.len());
    Ok(r.rows.get(offset..end).map(|s| s.to_vec()).unwrap_or_default())
}

#[tauri::command]
fn release_query(state: State<'_, AppState>, query_id: u64) {
    state.results.lock().unwrap().remove(&query_id);
}

fn main() {
    // Two async workers are plenty for a desktop client and keep idle memory low.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(8)
        .enable_all()
        .build()
        .expect("tokio runtime");
    tauri::async_runtime::set(rt.handle().clone());
    std::mem::forget(rt);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![explain, list_connections, save_connection, delete_connection, test_connection, connect_saved, schema_map, select_all_sql, connect, disconnect, list_objects, describe, run_query, get_rows, release_query])
        .run(tauri::generate_context!())
        .expect("error while running Lattice");
}
