use dbcore::{copy_text_row, ColumnMeta, Connection, DbError, Result, TableDdl, Value};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Deserialize)]
pub struct TableRef {
    pub schema: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BackupOptions {
    /// Tables to include; `None` = every table.
    pub tables: Option<Vec<TableRef>>,
    #[serde(default = "yes")]
    pub structure: bool,
    #[serde(default = "yes")]
    pub data: bool,
    #[serde(default = "yes")]
    pub views: bool,
        /// Wrap the script in a .zip (opens natively on Windows, macOS and Linux).
    #[serde(default, alias = "gzip")]
    pub zip: bool,
    /// Emit `DROP TABLE IF EXISTS` before each `CREATE TABLE`.
    #[serde(default)]
    pub add_drop: bool,
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupProgress {
    pub table: String,
    pub tables_done: usize,
    pub tables_total: usize,
    pub rows: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct BackupReport {
    pub tables: usize,
    pub rows: u64,
    pub bytes: u64,
}

fn io(e: std::io::Error) -> DbError {
    DbError::msg(e)
}

enum Out {
    Plain(BufWriter<File>),
    Zip(zip::ZipWriter<BufWriter<File>>),
}
impl Write for Out {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        match self { Out::Plain(w) => w.write(b), Out::Zip(w) => w.write(b) }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self { Out::Plain(w) => w.flush(), Out::Zip(w) => w.flush() }
    }
}

fn id(schema: &Option<String>, name: &str, conn: &dyn Connection) -> String {
    match schema.as_deref().filter(|s| !s.is_empty() && *s != "public") {
        Some(s) => format!("{}.{}", conn.quote(s), conn.quote(name)),
        None => conn.quote(name),
    }
}

/// Write a backup script of the connected database to `path`.
pub async fn backup(conn: &dyn Connection, path: &Path, opts: &BackupOptions, progress: &(dyn Fn(BackupProgress) + Send + Sync), cancel: &AtomicBool) -> Result<BackupReport> {
    let file = BufWriter::with_capacity(1 << 20, File::create(path).map_err(io)?);
    let mut out = if opts.zip {
        let mut z = zip::ZipWriter::new(file);
        let inner = path.file_stem().and_then(|s| s.to_str()).filter(|s| !s.is_empty()).unwrap_or("backup");
        let inner = if inner.ends_with(".sql") { inner.to_string() } else { format!("{inner}.sql") };
        let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).compression_level(Some(1)).large_file(true);
        z.start_file(inner, o).map_err(|e| DbError::msg(e))?;
        Out::Zip(z)
    } else { Out::Plain(file) };
    let result = write_backup(conn, &mut out, opts, progress, cancel).await;
    // `finish()` writes the zip central directory exactly once.
    let finished = match out {
        Out::Plain(mut w) => w.flush().map_err(io),
        Out::Zip(w) => w.finish().map_err(|e| DbError::msg(e)).and_then(|mut f| f.flush().map_err(io)),
    };
    match (result, finished) {
        (Ok(mut rep), Ok(())) => {
            rep.bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            Ok(rep)
        }
        (Err(e), _) | (Ok(_), Err(e)) => {
            let _ = std::fs::remove_file(path); // never leave a half-written backup behind
            Err(e)
        }
    }
}

async fn write_backup(conn: &dyn Connection, out: &mut Out, opts: &BackupOptions, progress: &(dyn Fn(BackupProgress) + Send + Sync), cancel: &AtomicBool) -> Result<BackupReport> {
    let dialect = conn.dialect();
    let wanted: Option<HashSet<(Option<String>, String)>> = opts.tables.as_ref().map(|t| t.iter().map(|x| (x.schema.clone(), x.name.clone())).collect());
    let tables: Vec<_> = conn.objects().await?.into_iter().filter(|o| o.kind == "table").filter(|o| wanted.as_ref().map_or(true, |w| w.contains(&(o.schema.clone(), o.name.clone())))).collect();
    let total = tables.len();
    let mut report = BackupReport { tables: total, ..Default::default() };

    writeln!(out, "-- Tabnix backup\n-- engine: {dialect}\n-- tables: {total}\n").map_err(io)?;
    for s in conn.dump_prelude() {
        writeln!(out, "{s}").map_err(io)?;
    }
    writeln!(out).map_err(io)?;

    // Structure
    let mut ddls: Vec<TableDdl> = Vec::new();
    if opts.structure {
        let mut schemas: Vec<String> = tables.iter().filter_map(|t| t.schema.clone()).collect();
        schemas.sort();
        schemas.dedup();
        for stmt in conn.dump_types(&schemas).await? {
            writeln!(out, "{stmt}").map_err(io)?;
        }
        let mut seen_pre = HashSet::new();
        for t in &tables {
            let ddl = conn.table_ddl(t.schema.as_deref(), &t.name).await?;
            for p in &ddl.pre {
                if seen_pre.insert(p.clone()) {
                    writeln!(out, "{p}").map_err(io)?;
                }
            }
            if opts.add_drop {
                writeln!(out, "DROP TABLE IF EXISTS {};", id(&t.schema, &t.name, conn)).map_err(io)?;
            }
            writeln!(out, "{}\n", ddl.create).map_err(io)?;
            ddls.push(ddl);
        }
    }

    // Data
    if opts.data {
        for (i, t) in tables.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err(DbError::Cancelled);
            }
            let skip: &[String] = ddls.get(i).map(|d| d.skip_columns.as_slice()).unwrap_or(&[]);
            let qualified = id(&t.schema, &t.name, conn);
            let cols_sql = if skip.is_empty() { "*".to_string() } else {
                // generated columns are computed by the database and can't be written
                let all = conn.describe(t.schema.as_deref(), &t.name).await?;
                all.columns.iter().filter(|c| !skip.contains(&c.name)).map(|c| conn.quote(&c.name)).collect::<Vec<_>>().join(", ")
            };
            let mut table_rows = 0u64;
            let name = t.name.clone();
            let mut buf = String::new();
            conn.query_batches(&format!("SELECT {cols_sql} FROM {qualified}"), 2000, &mut |cols: &[ColumnMeta], rows: Vec<Vec<Value>>| {
                if rows.is_empty() {
                    return Ok(true);
                }
                if cancel.load(Ordering::Relaxed) {
                    return Err(DbError::Cancelled);
                }
                let names = cols.iter().map(|c| conn.quote(&c.name)).collect::<Vec<_>>().join(", ");
                if dialect == "postgres" {
                    buf.clear();
                    for r in &rows {
                        copy_text_row(r, &mut buf);
                    }
                    write!(out, "COPY {qualified} ({names}) FROM stdin;\n{buf}\\.\n\n").map_err(io)?;
                } else {
                    // multi-row INSERTs, bounded by size so one statement never gets huge
                    let (mut sql, mut count) = (String::new(), 0usize);
                    let flush = |sql: &mut String, count: &mut usize, out: &mut Out| -> Result<()> {
                        if *count > 0 {
                            sql.push_str(";\n");
                            out.write_all(sql.as_bytes()).map_err(io)?;
                            sql.clear();
                            *count = 0;
                        }
                        Ok(())
                    };
                    for r in &rows {
                        let tuple = format!("({})", r.iter().map(|v| conn.literal(v)).collect::<Vec<_>>().join(", "));
                        if count > 0 && (sql.len() + tuple.len() > 256 * 1024 || count >= 1000) {
                            flush(&mut sql, &mut count, out)?;
                        }
                        if count == 0 {
                            sql = format!("INSERT INTO {qualified} ({names}) VALUES\n");
                        } else {
                            sql.push_str(",\n");
                        }
                        sql.push_str(&tuple);
                        count += 1;
                    }
                    flush(&mut sql, &mut count, out)?;
                    out.write_all(b"\n").map_err(io)?;
                }
                table_rows += rows.len() as u64;
                progress(BackupProgress { table: name.clone(), tables_done: i, tables_total: total, rows: report.rows + table_rows });
                Ok(true)
            }).await?;
            report.rows += table_rows;
            progress(BackupProgress { table: t.name.clone(), tables_done: i + 1, tables_total: total, rows: report.rows });
        }
    }

    // Indexes and foreign keys go last so load order doesn't matter.
    if opts.structure {
        for d in &ddls {
            for p in &d.post {
                writeln!(out, "{p}").map_err(io)?;
            }
        }
        writeln!(out).map_err(io)?;
        if opts.views {
            for v in conn.view_ddls().await? {
                writeln!(out, "{}\n", if v.trim_end().ends_with(';') { v } else { format!("{v};") }).map_err(io)?;
            }
        }
        if opts.data {
            for (t, d) in tables.iter().zip(&ddls) {
                for s in conn.sequence_resets(t.schema.as_deref(), &t.name, d) {
                    writeln!(out, "{s}").map_err(io)?;
                }
            }
        }
    }
    for s in conn.dump_epilogue() {
        writeln!(out, "{s}").map_err(io)?;
    }
    Ok(report)
}
