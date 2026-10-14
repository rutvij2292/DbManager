#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use dbcore::{build_dml, Change, ColumnMeta, ConnConfig, Connection, Driver, ObjectInfo, ObjectRef, PlanNode, QueryResult, SchemaTable, Value};
use driver_mongo::MongoDriver;
use driver_mssql::MssqlDriver;
use driver_mysql::MysqlDriver;
use driver_postgres::PostgresDriver;
use driver_redis::RedisDriver;
use driver_sqlite::SqliteDriver;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager, State};

/// Hard cap on rows kept per result (the UI pages through them).
const MAX_ROWS: usize = 200_000;

#[derive(Default)]
struct AppState {
    next_id: AtomicU64,
    conns: Mutex<HashMap<u64, Arc<dyn Connection>>>,
    results: Mutex<HashMap<u64, QueryResult>>,
    /// ssh processes keeping tunnels open, keyed by connection id (killed on drop).
    tunnels: Mutex<HashMap<u64, tokio::process::Child>>,
    /// Cancel flags of running import/export jobs.
    jobs: Mutex<HashMap<u64, Arc<std::sync::atomic::AtomicBool>>>,
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

/// Start `ssh -N -L` (using the user's keys / ssh-agent) and point the config at the local end.
async fn open_tunnel(config: &mut ConnConfig) -> Result<Option<tokio::process::Child>, String> {
    let Some(ssh_host) = config.ssh_host.clone().filter(|h| !h.is_empty()) else { return Ok(None) };
    let db_host = config.host.clone().unwrap_or_else(|| "127.0.0.1".into());
    let db_port = config.port.ok_or("a port is required for SSH tunnels")?;
    let local = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?.local_addr().map_err(|e| e.to_string())?.port();
    let target = match config.ssh_user.as_deref().filter(|u| !u.is_empty()) {
        Some(u) => format!("{u}@{ssh_host}"),
        None => ssh_host,
    };
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.args(["-N", "-L", &format!("127.0.0.1:{local}:{db_host}:{db_port}")])
        .args(["-p", &config.ssh_port.unwrap_or(22).to_string()])
        .args(["-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30"]);
    if let Some(k) = config.ssh_key.as_deref().filter(|k| !k.is_empty()) {
        cmd.args(["-i", k]);
    }
    let mut child = cmd.arg(target).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped()).kill_on_drop(true).spawn().map_err(|e| format!("could not start ssh: {e}"))?;
    for _ in 0..100 {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let mut err = String::new();
            if let Some(mut se) = child.stderr.take() {
                use tokio::io::AsyncReadExt;
                let _ = se.read_to_string(&mut err).await;
            }
            return Err(format!("SSH tunnel failed ({status}): {}", err.trim()));
        }
        if tokio::net::TcpStream::connect(("127.0.0.1", local)).await.is_ok() {
            config.host = Some("127.0.0.1".into());
            config.port = Some(local);
            return Ok(Some(child));
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err("SSH tunnel timed out after 10 s".into())
}

async fn open_conn(config: &ConnConfig) -> Result<Arc<dyn Connection>, String> {
    let conn = match config.kind.as_str() {
        "sqlite" => SqliteDriver.connect(config).await,
        // CockroachDB, Redshift and Greenplum speak the Postgres wire protocol.
        "postgres" | "cockroach" | "redshift" | "greenplum" => PostgresDriver.connect(config).await,
        // MariaDB speaks the MySQL wire protocol.
        "mysql" | "mariadb" => MysqlDriver.connect(config).await,
        "mssql" => MssqlDriver.connect(config).await,
        "redis" => RedisDriver.connect(config).await,
        "mongo" => MongoDriver.connect(config).await,
        k => return Err(format!("driver '{k}' is not implemented yet")),
    }
    .map_err(|e| e.to_string())?;
    conn.ping().await.map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Connect, going through an SSH tunnel when configured. The tunnel handle must be kept alive.
async fn open_conn_tunneled(mut config: ConnConfig) -> Result<(Arc<dyn Connection>, Option<tokio::process::Child>), String> {
    let tunnel = open_tunnel(&mut config).await?;
    let conn = open_conn(&config).await?;
    Ok((conn, tunnel))
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
    #[serde(default)]
    ssl: Option<String>,
    #[serde(default)]
    ssh_host: Option<String>,
    #[serde(default)]
    ssh_port: Option<u16>,
    #[serde(default)]
    ssh_user: Option<String>,
    #[serde(default)]
    ssh_key: Option<String>,
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
    open_conn_tunneled(config).await.map(|_| ())
}

#[tauri::command]
async fn connect_saved(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<u64, String> {
    let p = read_profiles(&app)?.into_iter().find(|p| p.id == id).ok_or("connection not found")?;
    let password = keychain(&id).ok().and_then(|e| e.get_password().ok());
    let config = ConnConfig {
        kind: p.kind, path: p.path, host: p.host, port: p.port, user: p.user, password, database: p.database,
        ssl: p.ssl, ssh_host: p.ssh_host, ssh_port: p.ssh_port, ssh_user: p.ssh_user, ssh_key: p.ssh_key,
    };
    let (conn, tunnel) = open_conn_tunneled(config).await?;
    let cid = state.id();
    state.conns.lock().unwrap().insert(cid, conn);
    if let Some(t) = tunnel {
        state.tunnels.lock().unwrap().insert(cid, t);
    }
    Ok(cid)
}

#[tauri::command]
async fn schema_map(state: State<'_, AppState>, conn_id: u64) -> Result<Vec<SchemaTable>, String> {
    state.conn(conn_id)?.schema_map().await.map_err(|e| e.to_string())
}

#[tauri::command]
fn select_all_sql(state: State<'_, AppState>, conn_id: u64, schema: Option<String>, name: String, limit: Option<usize>) -> Result<String, String> {
    Ok(state.conn(conn_id)?.select_all(schema.as_deref(), &name, limit.unwrap_or(1000)))
}

#[derive(Serialize, Clone)]
struct IoProgress {
    job: u64,
    rows: u64,
}

fn start_job(state: &AppState, job: u64) -> Arc<std::sync::atomic::AtomicBool> {
    let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state.jobs.lock().unwrap().insert(job, flag.clone());
    flag
}

#[tauri::command]
fn cancel_io(state: State<'_, AppState>, job: u64) {
    if let Some(f) = state.jobs.lock().unwrap().get(&job) {
        f.store(true, Ordering::Relaxed);
    }
}

/// Stream a query's full result to a file (no row cap, constant memory).
#[tauri::command]
async fn export_data(app: tauri::AppHandle, state: State<'_, AppState>, conn_id: u64, sql: String, path: String, options: dataio::ExportOptions, job: u64) -> Result<u64, String> {
    let conn = state.conn(conn_id)?;
    let flag = start_job(&state, job);
    let a = app.clone();
    let res = dataio::export(conn.as_ref(), &sql, std::path::Path::new(&path), &options, &move |rows| { let _ = a.emit("io-progress", IoProgress { job, rows }); }, &flag).await;
    state.jobs.lock().unwrap().remove(&job);
    res.map_err(|e| e.to_string())
}

#[tauri::command]
fn import_preview(path: String, has_header: bool, delimiter: Option<char>) -> Result<dataio::Preview, String> {
    dataio::preview(std::path::Path::new(&path), has_header, delimiter).map_err(|e| e.to_string())
}

#[tauri::command]
async fn import_data(app: tauri::AppHandle, state: State<'_, AppState>, conn_id: u64, path: String, options: dataio::ImportOptions, job: u64) -> Result<dataio::ImportReport, String> {
    let conn = state.conn(conn_id)?;
    let flag = start_job(&state, job);
    let a = app.clone();
    let res = dataio::import(conn.as_ref(), std::path::Path::new(&path), &options, &move |rows| { let _ = a.emit("io-progress", IoProgress { job, rows }); }, &flag).await;
    state.jobs.lock().unwrap().remove(&job);
    res.map_err(|e| e.to_string())
}

#[tauri::command]
async fn connect(state: State<'_, AppState>, config: ConnConfig) -> Result<u64, String> {
    let (conn, tunnel) = open_conn_tunneled(config).await?;
    let id = state.id();
    state.conns.lock().unwrap().insert(id, conn);
    if let Some(t) = tunnel {
        state.tunnels.lock().unwrap().insert(id, t);
    }
    Ok(id)
}

#[tauri::command]
fn disconnect(state: State<'_, AppState>, conn_id: u64) {
    state.conns.lock().unwrap().remove(&conn_id);
    state.tunnels.lock().unwrap().remove(&conn_id); // kill_on_drop closes the tunnel
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

/// Abort the query currently running on a connection.
#[tauri::command]
async fn cancel_query(state: State<'_, AppState>, conn_id: u64) -> Result<(), String> {
    state.conn(conn_id)?.cancel().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn explain(state: State<'_, AppState>, conn_id: u64, sql: String, analyze: bool) -> Result<PlanNode, String> {
    state.conn(conn_id)?.explain(&sql, analyze).await.map_err(|e| e.to_string())
}

/// Generate (and, unless `preview`, run) the SQL for staged row edits.
#[tauri::command]
async fn apply_changes(
    state: State<'_, AppState>,
    conn_id: u64,
    schema: Option<String>,
    table: String,
    changes: Vec<Change>,
    preview: bool,
) -> Result<Vec<String>, String> {
    let conn = state.conn(conn_id)?;
    let stmts = build_dml(conn.as_ref(), schema.as_deref(), &table, &changes);
    if !preview {
        conn.execute_batch(&stmts).await.map_err(|e| e.to_string())?;
    }
    Ok(stmts.into_iter().map(|(s, _)| s).collect())
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
        .invoke_handler(tauri::generate_handler![cancel_io, export_data, import_preview, import_data, cancel_query, apply_changes, explain, list_connections, save_connection, delete_connection, test_connection, connect_saved, schema_map, select_all_sql, connect, disconnect, list_objects, describe, run_query, get_rows, release_query])
        .run(tauri::generate_context!())
        .expect("error while running Lattice");
}
