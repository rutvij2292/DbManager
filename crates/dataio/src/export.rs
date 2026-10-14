use dbcore::{ColumnMeta, Connection, DbError, Result, Value};
use serde::Deserialize;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Tsv,
    Json,
    Jsonl,
    Sql,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportOptions {
    pub format: ExportFormat,
    #[serde(default = "yes")]
    pub header: bool,
    /// Override the CSV delimiter (ignored for other formats).
    pub delimiter: Option<char>,
    /// Table name used in generated INSERT statements (SQL format).
    pub table: Option<String>,
    /// Rows per fetch batch.
    #[serde(default = "default_batch")]
    pub batch_rows: usize,
}
fn yes() -> bool {
    true
}
fn default_batch() -> usize {
    5000
}

fn io(e: std::io::Error) -> DbError {
    DbError::msg(e)
}

/// Text for a delimited cell. NULL becomes an empty field.
fn cell(v: &Value, out: &mut String) {
    use std::fmt::Write as _;
    match v {
        Value::Null => {}
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::I64(i) => {
            let _ = write!(out, "{i}");
        }
        Value::F64(f) => {
            let _ = write!(out, "{f}");
        }
        Value::Text(t) => out.push_str(t),
        Value::Bytes(b) => {
            out.push_str("0x");
            for x in b {
                let _ = write!(out, "{x:02x}");
            }
        }
    }
}

fn write_delimited(w: &mut impl Write, fields: impl Iterator<Item = String>, delim: char) -> Result<()> {
    let mut first = true;
    for f in fields {
        if !first {
            write!(w, "{delim}").map_err(io)?;
        }
        first = false;
        let needs = f.contains(delim) || f.contains('"') || f.contains('\n') || f.contains('\r') || f.starts_with(' ') || f.ends_with(' ');
        if needs {
            w.write_all(b"\"").map_err(io)?;
            w.write_all(f.replace('"', "\"\"").as_bytes()).map_err(io)?;
            w.write_all(b"\"").map_err(io)?;
        } else {
            w.write_all(f.as_bytes()).map_err(io)?;
        }
    }
    w.write_all(b"\n").map_err(io)
}

fn json_value(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::I64(i) => i.to_string(),
        Value::F64(f) if f.is_finite() => f.to_string(),
        Value::F64(_) => "null".into(),
        Value::Text(t) => serde_json::to_string(t).unwrap(),
        Value::Bytes(_) => {
            let mut s = String::new();
            cell(v, &mut s);
            serde_json::to_string(&s).unwrap()
        }
    }
}

fn json_object(cols: &[ColumnMeta], row: &[Value]) -> String {
    let mut s = String::from("{");
    for (i, (c, v)) in cols.iter().zip(row).enumerate() {
        if i > 0 {
            s.push_str(", ");
        }
        s.push_str(&serde_json::to_string(&c.name).unwrap());
        s.push_str(": ");
        s.push_str(&json_value(v));
    }
    s.push('}');
    s
}

/// Run `sql` and stream the result to `path`. `progress` receives the running row count after each
/// batch. Setting `cancel` aborts and removes the partial file. Returns the rows written.
pub async fn export(
    conn: &dyn Connection,
    sql: &str,
    path: &Path,
    opts: &ExportOptions,
    progress: &(dyn Fn(u64) + Send + Sync),
    cancel: &AtomicBool,
) -> Result<u64> {
    let mut w = BufWriter::with_capacity(1 << 20, File::create(path).map_err(io)?);
    let delim = match opts.format {
        ExportFormat::Tsv => '\t',
        _ => opts.delimiter.unwrap_or(','),
    };
    let (mut started, mut total, mut json_rows) = (false, 0u64, 0u64);
    let table = opts.table.clone().unwrap_or_else(|| "export".into());

    let res = conn
        .query_batches(sql, opts.batch_rows.max(1), &mut |cols, rows| {
            if cancel.load(Ordering::Relaxed) {
                return Err(DbError::Cancelled);
            }
            if !started {
                started = true;
                match opts.format {
                    ExportFormat::Csv | ExportFormat::Tsv if opts.header => {
                        write_delimited(&mut w, cols.iter().map(|c| c.name.clone()), delim)?;
                    }
                    ExportFormat::Json => w.write_all(b"[\n").map_err(io)?,
                    _ => {}
                }
            }
            let mut buf = String::new();
            match opts.format {
                ExportFormat::Csv | ExportFormat::Tsv => {
                    for row in &rows {
                        write_delimited(
                            &mut w,
                            row.iter().map(|v| {
                                buf.clear();
                                cell(v, &mut buf);
                                buf.clone()
                            }),
                            delim,
                        )?;
                    }
                }
                ExportFormat::Json => {
                    for row in &rows {
                        if json_rows > 0 {
                            w.write_all(b",\n").map_err(io)?;
                        }
                        json_rows += 1;
                        w.write_all(b"  ").map_err(io)?;
                        w.write_all(json_object(cols, row).as_bytes()).map_err(io)?;
                    }
                }
                ExportFormat::Jsonl => {
                    for row in &rows {
                        w.write_all(json_object(cols, row).as_bytes()).map_err(io)?;
                        w.write_all(b"\n").map_err(io)?;
                    }
                }
                ExportFormat::Sql => {
                    let names = cols.iter().map(|c| conn.quote(&c.name)).collect::<Vec<_>>().join(", ");
                    for chunk in rows.chunks(500) {
                        let values = chunk
                            .iter()
                            .map(|r| format!("({})", r.iter().map(|v| conn.literal(v)).collect::<Vec<_>>().join(", ")))
                            .collect::<Vec<_>>()
                            .join(",\n  ");
                        writeln!(w, "INSERT INTO {} ({names}) VALUES\n  {values};", conn.quote(&table)).map_err(io)?;
                    }
                }
            }
            total += rows.len() as u64;
            progress(total);
            Ok(true)
        })
        .await;

    let finish = |w: &mut BufWriter<File>| -> Result<()> {
        if opts.format == ExportFormat::Json {
            if !started {
                w.write_all(b"[").map_err(io)?;
            }
            w.write_all(b"\n]\n").map_err(io)?;
        }
        w.flush().map_err(io)
    };
    match res {
        Ok(_) => {
            finish(&mut w)?;
            progress(total);
            Ok(total)
        }
        Err(e) => {
            drop(w);
            let _ = std::fs::remove_file(path);
            Err(e)
        }
    }
}
