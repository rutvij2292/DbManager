use dbcore::{Connection, DbError, Result, Value};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColType {
    Integer,
    Real,
    Text,
}

#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub headers: Vec<String>,
    pub sample: Vec<Vec<Option<String>>>,
    pub types: Vec<ColType>,
    pub delimiter: char,
    pub format: &'static str,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportOptions {
    pub schema: Option<String>,
    pub table: String,
    /// Create the table first, with column types inferred from the whole file.
    #[serde(default)]
    pub create: bool,
    #[serde(default = "yes")]
    pub has_header: bool,
    pub delimiter: Option<char>,
    /// Target column for each source column; `None` skips it.
    pub mapping: Vec<Option<String>>,
    #[serde(default = "yes")]
    pub empty_as_null: bool,
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportReport {
    pub rows: u64,
    pub created: bool,
}

type Row = Vec<Option<String>>;

enum Kind {
    Delimited(char),
    Json,
    Jsonl,
}

fn kind_of(path: &Path, delimiter: Option<char>) -> Result<Kind> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    Ok(match ext.as_str() {
        "json" => Kind::Json,
        "jsonl" | "ndjson" => Kind::Jsonl,
        "tsv" => Kind::Delimited(delimiter.unwrap_or('\t')),
        _ => Kind::Delimited(match delimiter {
            Some(d) => d,
            None => sniff(path)?,
        }),
    })
}

fn sniff(path: &Path) -> Result<char> {
    use std::io::{BufRead, BufReader};
    let mut line = String::new();
    BufReader::new(File::open(path).map_err(DbError::msg)?).read_line(&mut line).map_err(DbError::msg)?;
    Ok([',', ';', '\t', '|'].into_iter().max_by_key(|d| line.matches(*d).count()).filter(|d| line.contains(*d)).unwrap_or(','))
}

fn json_cell(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// Whole-file JSON sources: (headers, rows).
fn read_json(path: &Path, lines: bool) -> Result<(Vec<String>, Vec<Row>)> {
    let text = std::fs::read_to_string(path).map_err(DbError::msg)?;
    let objects: Vec<serde_json::Value> = if lines {
        text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l)).collect::<std::result::Result<_, _>>().map_err(DbError::msg)?
    } else {
        match serde_json::from_str(&text).map_err(DbError::msg)? {
            serde_json::Value::Array(a) => a,
            _ => return Err(DbError::msg("JSON import expects an array of objects")),
        }
    };
    let mut headers: Vec<String> = Vec::new();
    for o in &objects {
        let m = o.as_object().ok_or_else(|| DbError::msg("JSON import expects an array of objects"))?;
        for k in m.keys() {
            if !headers.contains(k) {
                headers.push(k.clone());
            }
        }
    }
    let rows = objects.iter().map(|o| headers.iter().map(|h| o.get(h).and_then(json_cell)).collect()).collect();
    Ok((headers, rows))
}

/// Pull-based row reader: delimited files stream from disk, JSON is loaded whole.
struct RowSource {
    headers: Vec<String>,
    inner: Inner,
}
enum Inner {
    Csv(csv::StringRecordsIntoIter<File>, Option<Row>),
    Mem(std::vec::IntoIter<Row>),
}

impl RowSource {
    fn open(path: &Path, kind: &Kind, has_header: bool) -> Result<RowSource> {
        match kind {
            Kind::Delimited(d) => {
                let rd = csv::ReaderBuilder::new().delimiter(*d as u8).has_headers(false).flexible(true).from_path(path).map_err(DbError::msg)?;
                let mut it = rd.into_records();
                let mut peeked = None;
                let headers = match it.next() {
                    None => vec![],
                    Some(first) => {
                        let first = first.map_err(DbError::msg)?;
                        if has_header {
                            first.iter().map(|s| s.trim_start_matches('\u{feff}').trim().to_string()).collect()
                        } else {
                            peeked = Some(first.iter().map(|s| Some(s.to_string())).collect());
                            (1..=first.len()).map(|i| format!("column{i}")).collect()
                        }
                    }
                };
                Ok(RowSource { headers, inner: Inner::Csv(it, peeked) })
            }
            Kind::Json | Kind::Jsonl => {
                let (headers, rows) = read_json(path, matches!(kind, Kind::Jsonl))?;
                Ok(RowSource { headers, inner: Inner::Mem(rows.into_iter()) })
            }
        }
    }
    fn next_row(&mut self) -> Result<Option<Row>> {
        match &mut self.inner {
            Inner::Mem(it) => Ok(it.next()),
            Inner::Csv(it, peeked) => {
                if let Some(r) = peeked.take() {
                    return Ok(Some(r));
                }
                match it.next() {
                    None => Ok(None),
                    Some(rec) => Ok(Some(rec.map_err(DbError::msg)?.iter().map(|s| Some(s.to_string())).collect())),
                }
            }
        }
    }
}

fn is_int(s: &str) -> bool {
    let t = s.strip_prefix('-').unwrap_or(s);
    !t.is_empty() && t.len() <= 18 && t.bytes().all(|b| b.is_ascii_digit()) && (t == "0" || !t.starts_with('0'))
}
fn is_real(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('+') && s.parse::<f64>().map(|f| f.is_finite()).unwrap_or(false) && !s.eq_ignore_ascii_case("nan") && !s.to_ascii_lowercase().contains("inf")
        && !(s.len() > 1 && s.starts_with('0') && !s.starts_with("0."))
}

struct Infer(Vec<(bool, bool, bool)>); // (any value, all int, all real)
impl Infer {
    fn new(n: usize) -> Self {
        Infer(vec![(false, true, true); n])
    }
    fn add(&mut self, row: &Row, empty_null: bool) {
        for (i, cell) in row.iter().enumerate() {
            let Some(s) = cell.as_deref() else { continue };
            if (s.is_empty() && empty_null) || i >= self.0.len() {
                continue;
            }
            let e = &mut self.0[i];
            e.0 = true;
            e.1 &= is_int(s);
            e.2 &= is_real(s) || is_int(s);
        }
    }
    fn types(&self) -> Vec<ColType> {
        self.0.iter().map(|(any, int, real)| if !any { ColType::Text } else if *int { ColType::Integer } else if *real { ColType::Real } else { ColType::Text }).collect()
    }
}

/// Read the head of a file: headers, sample rows and a first guess at column types.
pub fn preview(path: &Path, has_header: bool, delimiter: Option<char>) -> Result<Preview> {
    let kind = kind_of(path, delimiter)?;
    let mut src = RowSource::open(path, &kind, has_header)?;
    let (mut sample, mut inf) = (Vec::new(), Infer::new(src.headers.len()));
    while sample.len() < 1000 {
        let Some(row) = src.next_row()? else { break };
        inf.add(&row, true);
        sample.push(row);
    }
    let n = src.headers.len().max(sample.first().map(|r| r.len()).unwrap_or(0));
    let mut types = inf.types();
    types.resize(n, ColType::Text);
    let mut headers = src.headers;
    if headers.len() < n {
        headers.extend((headers.len() + 1..=n).map(|i| format!("column{i}")));
    }
    Ok(Preview {
        headers,
        sample: sample.into_iter().take(8).collect(),
        types,
        delimiter: match kind { Kind::Delimited(d) => d, _ => ',' },
        format: match kind { Kind::Delimited(_) => "delimited", Kind::Json => "json", Kind::Jsonl => "jsonl" },
    })
}

fn sql_type(dialect: &str, t: ColType) -> &'static str {
    match (dialect, t) {
        ("sqlite", ColType::Integer) => "INTEGER",
        ("sqlite", ColType::Real) => "REAL",
        ("sqlite", ColType::Text) => "TEXT",
        ("postgres", ColType::Integer) | ("mysql", ColType::Integer) | ("mssql", ColType::Integer) => "BIGINT",
        ("postgres", ColType::Real) => "DOUBLE PRECISION",
        ("mysql", ColType::Real) => "DOUBLE",
        ("mssql", ColType::Real) => "FLOAT",
        ("mysql", ColType::Text) => "LONGTEXT",
        ("mssql", ColType::Text) => "NVARCHAR(MAX)",
        (_, ColType::Integer) => "BIGINT",
        (_, ColType::Real) => "DOUBLE PRECISION",
        (_, ColType::Text) => "TEXT",
    }
}

/// Rows read and committed together. Large enough to amortise round trips, small enough to bound memory.
const CHUNK_ROWS: usize = 20_000;
/// Upper size of one multi-row INSERT when no bulk path exists (stays well under MySQL's 4 MB default packet).
const STATEMENT_BYTES: usize = 512 * 1024;

/// Import `path` into a table in 20,000-row chunks, one transaction each. Uses the driver's bulk path
/// (Postgres COPY, SQLite prepared statements) when it has one, else byte-sized multi-row INSERTs.
/// A failure reports how many rows were already committed.
pub async fn import(conn: &dyn Connection, path: &Path, opts: &ImportOptions, progress: &(dyn Fn(u64) + Send + Sync), cancel: &AtomicBool) -> Result<ImportReport> {
    let kind = kind_of(path, opts.delimiter)?;
    let mut targets: Vec<(usize, String)> = opts.mapping.iter().enumerate().filter_map(|(i, t)| t.clone().filter(|t| !t.is_empty()).map(|t| (i, t))).collect();
    if targets.is_empty() {
        return Err(DbError::msg("no columns are mapped"));
    }
    let table = match opts.schema.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => format!("{}.{}", conn.quote(s), conn.quote(&opts.table)),
        None => conn.quote(&opts.table),
    };

    let mut types: Vec<ColType> = vec![ColType::Text; opts.mapping.len()];
    if opts.create {
        // Types come from a full pass so one odd value late in the file can't break the insert.
        let mut src = RowSource::open(path, &kind, opts.has_header)?;
        let mut inf = Infer::new(opts.mapping.len());
        while let Some(row) = src.next_row()? {
            inf.add(&row, opts.empty_as_null);
        }
        types = inf.types();
        let mut seen = std::collections::HashSet::new();
        for (_, name) in targets.iter_mut() {
            while !seen.insert(name.to_lowercase()) {
                name.push('_');
            }
        }
        let cols = targets.iter().map(|(i, n)| format!("{} {}", conn.quote(n), sql_type(conn.dialect(), types[*i]))).collect::<Vec<_>>().join(", ");
        conn.query(&format!("CREATE TABLE {table} ({cols})")).await?;
    }

    let col_names: Vec<String> = targets.iter().map(|(_, n)| n.clone()).collect();
    let col_list = col_names.iter().map(|n| conn.quote(n)).collect::<Vec<_>>().join(", ");
    let cell_value = |r: &Row, i: usize| -> Value {
        match r.get(i).cloned().flatten() {
            None => Value::Null,
            Some(s) if s.is_empty() && opts.empty_as_null => Value::Null,
            Some(s) => match types[i] {
                ColType::Integer if opts.create => s.parse().map(Value::I64).unwrap_or(Value::Text(s)),
                ColType::Real if opts.create => s.parse().map(Value::F64).unwrap_or(Value::Text(s)),
                _ => Value::Text(s),
            },
        }
    };
    // SQL Server allows at most 1000 rows in one VALUES list.
    let max_rows = if conn.dialect() == "mssql" { 1000 } else { 5000 };
    let schema = opts.schema.as_deref().filter(|s| !s.is_empty());

    let mut src = RowSource::open(path, &kind, opts.has_header)?;
    let mut chunk: Vec<Row> = Vec::with_capacity(CHUNK_ROWS);
    let mut committed = 0u64;
    let fail = |e: DbError, committed: u64| DbError::msg(format!("{e} (import stopped; {committed} rows were already committed)"));
    loop {
        let row = src.next_row()?;
        let done = row.is_none();
        if let Some(r) = row {
            chunk.push(r);
        }
        if chunk.len() >= CHUNK_ROWS || (done && !chunk.is_empty()) {
            if cancel.load(Ordering::Relaxed) {
                return Err(DbError::Cancelled);
            }
            let values: Vec<Vec<Value>> = chunk.iter().map(|r| targets.iter().map(|(i, _)| cell_value(r, *i)).collect()).collect();
            let n = match conn.bulk_insert(schema, &opts.table, &col_names, &values).await.map_err(|e| fail(e, committed))? {
                Some(n) => n,
                None => {
                    // No native bulk path: multi-row INSERTs sized by bytes, in one transaction per chunk.
                    let mut stmts: Vec<(String, Option<u64>)> = Vec::new();
                    let (mut sql, mut count) = (String::new(), 0u64);
                    for r in &values {
                        let tuple = format!("({})", r.iter().map(|v| conn.literal(v)).collect::<Vec<_>>().join(", "));
                        if count > 0 && (sql.len() + tuple.len() > STATEMENT_BYTES || count as usize >= max_rows) {
                            stmts.push((std::mem::take(&mut sql), Some(count)));
                            count = 0;
                        }
                        if count == 0 {
                            sql = format!("INSERT INTO {table} ({col_list}) VALUES ");
                        } else {
                            sql.push_str(", ");
                        }
                        sql.push_str(&tuple);
                        count += 1;
                    }
                    if count > 0 {
                        stmts.push((sql, Some(count)));
                    }
                    conn.execute_batch(&stmts).await.map_err(|e| fail(e, committed))?
                }
            };
            committed += n;
            chunk.clear();
            progress(committed);
        }
        if done {
            break;
        }
    }
    Ok(ImportReport { rows: committed, created: opts.create })
}
