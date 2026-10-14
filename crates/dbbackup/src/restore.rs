use crate::script::{Item, ScriptReader};
use dbcore::{Connection, DbError, Result, Session};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Deserialize)]
pub struct RestoreOptions {
    /// Stop at the first failing statement (default) instead of collecting errors and carrying on.
    #[serde(default = "yes")]
    pub stop_on_error: bool,
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreProgress {
    pub statements: u64,
    pub bytes_read: u64,
    pub bytes_total: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RestoreReport {
    pub statements: u64,
    pub copied_rows: u64,
    pub failed: u64,
    /// First few failures: (statement preview, error).
    pub errors: Vec<(String, String)>,
}

fn open(path: &Path) -> Result<(Box<dyn BufRead + Send>, u64)> {
    let mut f = File::open(path).map_err(DbError::msg)?;
    let total = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut magic = [0u8; 2];
    let gz = f.read(&mut magic).map_err(DbError::msg)? == 2 && magic == [0x1f, 0x8b];
    drop(f);
    let f = File::open(path).map_err(DbError::msg)?;
    Ok(if gz { (Box::new(BufReader::with_capacity(1 << 20, flate2::read::GzDecoder::new(f))), total) } else { (Box::new(BufReader::with_capacity(1 << 20, f)), total) })
}

fn preview(s: &str) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > 160 { format!("{}…", one.chars().take(160).collect::<String>()) } else { one }
}

/// Run a SQL script (plain or gzip) against the connection.
pub async fn restore(conn: &dyn Connection, path: &Path, opts: &RestoreOptions, progress: &(dyn Fn(RestoreProgress) + Send + Sync), cancel: &AtomicBool) -> Result<RestoreReport> {
    let (reader, total) = open(path)?;
    let mut script = ScriptReader::new(reader, conn.dialect());
    let mut session: Option<Box<dyn Session>> = conn.open_session().await?;
    let mut report = RestoreReport::default();
    let mut last_emit = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(DbError::Cancelled);
        }
        let Some(item) = script.next_item().map_err(DbError::msg)? else { break };
        let (label, res): (String, Result<u64>) = match item {
            Item::Statement(sql) => {
                let r = match session.as_mut() {
                    Some(s) => s.execute(&sql).await,
                    None => conn.query(&sql).await.map(|q| q.affected.unwrap_or(0)),
                };
                (sql, r)
            }
            Item::Copy { statement, data } => {
                let r = conn.copy_from_stdin(&statement, data).await;
                if let Ok(n) = &r {
                    report.copied_rows += n;
                }
                (statement, r.map(|_| 0))
            }
        };
        report.statements += 1;
        if let Err(e) = res {
            report.failed += 1;
            let msg = format!("{e}");
            if report.errors.len() < 20 {
                report.errors.push((preview(&label), msg.clone()));
            }
            if opts.stop_on_error {
                return Err(DbError::msg(format!("statement {} failed: {msg}\n  {}", report.statements, preview(&label))));
            }
        }
        if last_emit.elapsed().as_millis() >= 150 {
            last_emit = std::time::Instant::now();
            progress(RestoreProgress { statements: report.statements, bytes_read: script.bytes_read, bytes_total: total });
        }
    }
    progress(RestoreProgress { statements: report.statements, bytes_read: total, bytes_total: total });
    Ok(report)
}
