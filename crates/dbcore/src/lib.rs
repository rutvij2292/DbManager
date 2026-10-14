//! Core types and driver traits for Lattice.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("{0}")]
    Message(String),
    #[error("cancelled")]
    Cancelled,
}
/// Receiver of streamed result batches; return `Ok(false)` to stop early.
/// (Explicit `for<'a>` because `async_trait` would otherwise pin the elided lifetime.)
pub type RowSink<'s> = dyn for<'a> FnMut(&'a [ColumnMeta], Vec<Vec<Value>>) -> Result<bool> + Send + 's;

pub type Result<T> = std::result::Result<T, DbError>;

impl DbError {
    pub fn msg(e: impl std::fmt::Display) -> Self {
        DbError::Message(e.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", content = "v")]
pub enum Value {
    Null,
    Bool(bool),
    I64(i64),
    F64(f64),
    Text(String),
    Bytes(Vec<u8>),
}

impl Value {
    pub fn display(&self) -> String {
        match self {
            Value::Null => "NULL".into(),
            Value::Bool(b) => b.to_string(),
            Value::I64(i) => i.to_string(),
            Value::F64(f) => f.to_string(),
            Value::Text(s) => s.clone(),
            Value::Bytes(b) => format!("<{} bytes>", b.len()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    pub affected: Option<u64>,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub default: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectRef {
    pub schema: Option<String>,
    pub name: String,
    pub kind: String, // table | view
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaTable {
    pub schema: Option<String>,
    pub name: String,
    pub columns: Vec<String>,
}

/// Dialect-neutral query plan node, rendered by the UI as a tree.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlanNode {
    pub op: String,
    pub detail: String,
    pub relation: Option<String>,
    pub est_rows: Option<f64>,
    pub actual_rows: Option<f64>,
    pub cost: Option<f64>,
    pub time_ms: Option<f64>,
    pub children: Vec<PlanNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErColumn {
    pub name: String,
    pub type_name: String,
    pub primary_key: bool,
    pub nullable: bool,
    pub foreign_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErTable {
    /// `schema.table`, or just `table` for the default schema.
    pub id: String,
    pub schema: Option<String>,
    pub name: String,
    pub columns: Vec<ErColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErRelation {
    pub name: String,
    pub from_table: String,
    pub from_columns: Vec<String>,
    pub to_table: String,
    pub to_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErSchema {
    pub tables: Vec<ErTable>,
    pub relations: Vec<ErRelation>,
    pub truncated: bool,
    pub total_tables: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ObjectInfo {
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<String>,
    pub ddl: Option<String>,
    #[serde(default)]
    pub index_details: Vec<IndexInfo>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKey>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConnConfig {
    pub kind: String,
    pub path: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    /// "disable" | "prefer" | "require" (encrypt, don't verify) | "verify" (verify against system roots)
    #[serde(default)]
    pub ssl: Option<String>,
    /// Unix domain socket path (MySQL/MariaDB, Postgres) instead of host/port.
    #[serde(default)]
    pub socket: Option<String>,
    #[serde(default)]
    pub ssh_host: Option<String>,
    #[serde(default)]
    pub ssh_port: Option<u16>,
    #[serde(default)]
    pub ssh_user: Option<String>,
    #[serde(default)]
    pub ssh_key: Option<String>,
}

#[async_trait]
pub trait Connection: Send + Sync {
    fn dialect(&self) -> &'static str;
    async fn ping(&self) -> Result<()>;
    async fn objects(&self) -> Result<Vec<ObjectRef>>;
    /// Databases on the server this connection can open (empty when the engine has no such notion).
    async fn databases(&self) -> Result<Vec<String>> {
        Ok(vec![])
    }
    async fn describe(&self, schema: Option<&str>, name: &str) -> Result<ObjectInfo>;
    async fn query(&self, sql: &str) -> Result<QueryResult>;
    /// Stream the result of `sql` to `sink` in batches of up to `batch_rows` rows, so exports of
    /// huge tables use constant memory. The sink always sees the columns at least once (even for an
    /// empty result); returning `Ok(false)` stops early. Returns the number of rows delivered.
    /// The default buffers the whole result; drivers override it where streaming is possible.
    async fn query_batches(&self, sql: &str, batch_rows: usize, sink: &mut RowSink) -> Result<u64> {
        let QueryResult { columns, mut rows, .. } = self.query(sql).await?;
        let total = rows.len() as u64;
        if rows.is_empty() {
            sink(&columns, vec![])?;
            return Ok(0);
        }
        while !rows.is_empty() {
            let rest = rows.split_off(batch_rows.min(rows.len()));
            let chunk = std::mem::replace(&mut rows, rest);
            if !sink(&columns, chunk)? {
                break;
            }
        }
        Ok(total)
    }
    /// Tables, columns and foreign-key relations for an entity-relationship diagram. With `focus`,
    /// only that table and the tables directly related to it (either direction) are returned.
    /// Without it, at most `limit` tables are returned (`truncated` says whether more exist).
    async fn er_schema(&self, focus: Option<&str>, limit: usize) -> Result<ErSchema> {
        let id = |schema: &Option<String>, name: &str| match schema.as_deref() {
            Some(s) if !s.is_empty() && s != "public" => format!("{s}.{name}"),
            _ => name.to_string(),
        };
        let mut tables: Vec<ErTable> = Vec::new();
        let mut relations: Vec<ErRelation> = Vec::new();
        for o in self.objects().await?.into_iter().filter(|o| o.kind == "table") {
            let info = self.describe(o.schema.as_deref(), &o.name).await?;
            let from = id(&o.schema, &o.name);
            for fk in &info.foreign_keys {
                relations.push(ErRelation {
                    name: fk.name.clone(),
                    from_table: from.clone(),
                    from_columns: fk.columns.clone(),
                    to_table: id(&fk.ref_schema.clone().or_else(|| o.schema.clone()), &fk.ref_table),
                    to_columns: fk.ref_columns.clone(),
                });
            }
            let fk_cols: Vec<&String> = info.foreign_keys.iter().flat_map(|f| f.columns.iter()).collect();
            tables.push(ErTable {
                id: from,
                schema: o.schema.clone(),
                name: o.name.clone(),
                columns: info.columns.iter().map(|c| ErColumn { name: c.name.clone(), type_name: c.type_name.clone(), primary_key: c.primary_key, nullable: c.nullable, foreign_key: fk_cols.contains(&&c.name) }).collect(),
            });
        }
        let total = tables.len();
        if let Some(f) = focus {
            let focus_id = tables.iter().find(|t| t.id == f || t.name == f).map(|t| t.id.clone()).ok_or_else(|| DbError::msg(format!("table '{f}' not found")))?;
            let mut keep: std::collections::HashSet<String> = std::collections::HashSet::from([focus_id.clone()]);
            for r in &relations {
                if r.from_table == focus_id {
                    keep.insert(r.to_table.clone());
                }
                if r.to_table == focus_id {
                    keep.insert(r.from_table.clone());
                }
            }
            tables.retain(|t| keep.contains(&t.id));
        } else if tables.len() > limit {
            tables.sort_by(|a, b| a.id.cmp(&b.id));
            tables.truncate(limit);
        }
        let ids: std::collections::HashSet<&String> = tables.iter().map(|t| &t.id).collect();
        relations.retain(|r| ids.contains(&r.from_table) && ids.contains(&r.to_table));
        Ok(ErSchema { truncated: focus.is_none() && total > tables.len(), total_tables: total, tables, relations })
    }
    // ---- backup / restore -------------------------------------------------------------------
    /// DDL to recreate a table. Drivers that can't dump return an error saying so.
    async fn table_ddl(&self, _schema: Option<&str>, _table: &str) -> Result<TableDdl> {
        Err(DbError::msg("backup is not supported for this kind of database yet"))
    }
    /// `CREATE VIEW` statements for the current database.
    async fn view_ddls(&self) -> Result<Vec<String>> {
        Ok(vec![])
    }
    /// Statements that must run before any table: schemas, enum types.
    async fn dump_types(&self, _schemas: &[String]) -> Result<Vec<String>> {
        Ok(vec![])
    }
    /// Session settings at the top and bottom of a dump (foreign-key checks off/on, ...).
    fn dump_prelude(&self) -> Vec<String> {
        vec![]
    }
    fn dump_epilogue(&self) -> Vec<String> {
        vec![]
    }
    /// Statements to run after all data is loaded to realign sequences with the data.
    fn sequence_resets(&self, _schema: Option<&str>, _table: &str, _ddl: &TableDdl) -> Vec<String> {
        vec![]
    }
    /// A stateful session for running a script, when `query()` can't keep session state.
    async fn open_session(&self) -> Result<Option<Box<dyn Session>>> {
        Ok(None)
    }
    /// Run `COPY … FROM STDIN` with the given text data (Postgres only).
    async fn copy_from_stdin(&self, _statement: &str, _data: Vec<u8>) -> Result<u64> {
        Err(DbError::msg("COPY ... FROM stdin is only supported on PostgreSQL"))
    }
    /// Fast bulk insert (Postgres `COPY`, SQLite prepared statements). Returns the rows inserted, or
    /// `Ok(None)` when the driver has no faster path than ordinary INSERT statements. Each call is
    /// its own transaction.
    async fn bulk_insert(&self, _schema: Option<&str>, _table: &str, _columns: &[String], _rows: &[Vec<Value>]) -> Result<Option<u64>> {
        Ok(None)
    }
    /// Let the server write CSV itself (Postgres `COPY … TO STDOUT`). Returns the data rows written,
    /// or `Ok(None)` when unsupported. `cancel` is polled between chunks.
    async fn native_csv_export(&self, _sql: &str, _header: bool, _delimiter: char, _out: &mut (dyn std::io::Write + Send), _cancel: &(dyn Fn() -> bool + Send + Sync), _progress: &(dyn Fn(u64) + Send + Sync)) -> Result<Option<u64>> {
        Ok(None)
    }
    /// Abort whatever is currently running on this connection (best effort; no-op if idle).
    async fn cancel(&self) -> Result<()> {
        Err(DbError::msg("cancel is not supported for this driver"))
    }
    /// Query plan for `sql`; `analyze` actually executes it where supported.
    async fn explain(&self, _sql: &str, _analyze: bool) -> Result<PlanNode> {
        Err(DbError::msg("EXPLAIN is not supported for this driver"))
    }
    /// Statement that opens a transaction in this dialect.
    fn begin_sql(&self) -> &'static str {
        "BEGIN"
    }
    /// SQL literal for a value in this dialect.
    fn literal(&self, v: &Value) -> String {
        match v {
            Value::Null => "NULL".into(),
            Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
            Value::I64(i) => i.to_string(),
            Value::F64(f) => f.to_string(),
            Value::Text(t) => format!("'{}'", t.replace('\'', "''")),
            Value::Bytes(b) => format!("X'{}'", b.iter().map(|x| format!("{x:02x}")).collect::<String>()),
        }
    }
    /// Run statements in one transaction. Each carries the exact affected-row count it must produce
    /// (`None` = don't check); any mismatch or error rolls everything back.
    async fn execute_batch(&self, stmts: &[(String, Option<u64>)]) -> Result<u64> {
        self.query(self.begin_sql()).await?;
        let mut total = 0;
        for (sql, expect) in stmts {
            let r = match self.query(sql).await {
                Ok(r) => r,
                Err(e) => {
                    let _ = self.query("ROLLBACK").await;
                    return Err(e);
                }
            };
            let n = r.affected.unwrap_or(0);
            if let Some(want) = expect {
                if n != *want {
                    let _ = self.query("ROLLBACK").await;
                    return Err(DbError::msg(format!("rolled back: expected {want} row(s) affected but got {n} for: {sql}")));
                }
            }
            total += n;
        }
        self.query("COMMIT").await?;
        Ok(total)
    }
    /// Quote an identifier for this dialect.
    fn quote(&self, ident: &str) -> String {
        format!("\"{}\"", ident.replace('"', "\"\""))
    }
    /// `SELECT * FROM <table> LIMIT n` in this dialect.
    fn select_all(&self, schema: Option<&str>, name: &str, limit: usize) -> String {
        let t = match schema {
            Some(s) => format!("{}.{}", self.quote(s), self.quote(name)),
            None => self.quote(name),
        };
        format!("SELECT * FROM {t} LIMIT {limit}")
    }
    /// `SELECT * FROM <table> WHERE <filter> LIMIT n` in this dialect. `filter` is a trusted,
    /// user-typed condition (the same text they could run in the query editor).
    fn select_where(&self, schema: Option<&str>, name: &str, filter: &str, limit: usize) -> String {
        let t = match schema {
            Some(s) => format!("{}.{}", self.quote(s), self.quote(name)),
            None => self.quote(name),
        };
        format!("SELECT * FROM {t} WHERE {filter} LIMIT {limit}")
    }
    /// `SELECT * FROM <table> [WHERE …] [ORDER BY …] LIMIT n` in this dialect. `filter` and `order`
    /// are trusted, user-built fragments (the same text they could type in the editor).
    fn select_rows(&self, schema: Option<&str>, name: &str, filter: Option<&str>, order: Option<&str>, limit: usize) -> String {
        let t = match schema {
            Some(s) => format!("{}.{}", self.quote(s), self.quote(name)),
            None => self.quote(name),
        };
        let mut sql = format!("SELECT * FROM {t}");
        if let Some(f) = filter.map(str::trim).filter(|f| !f.is_empty()) {
            sql.push_str(&format!(" WHERE {f}"));
        }
        if let Some(o) = order.map(str::trim).filter(|o| !o.is_empty()) {
            sql.push_str(&format!(" ORDER BY {o}"));
        }
        format!("{sql} LIMIT {limit}")
    }
    /// All tables with their column names, for editor autocomplete.
    async fn schema_map(&self) -> Result<Vec<SchemaTable>> {
        let mut out = Vec::new();
        for o in self.objects().await? {
            let cols = self.describe(o.schema.as_deref(), &o.name).await?.columns.into_iter().map(|c| c.name).collect();
            out.push(SchemaTable { schema: o.schema, name: o.name, columns: cols });
        }
        Ok(out)
    }
}

#[async_trait]
pub trait Driver: Send + Sync {
    fn kind(&self) -> &'static str;
    async fn connect(&self, cfg: &ConnConfig) -> Result<Arc<dyn Connection>>;
}


/// What a dump needs to recreate one table.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TableDdl {
    /// Run before the table exists (sequences it depends on).
    pub pre: Vec<String>,
    pub create: String,
    /// Run after the data is loaded: indexes, foreign keys, sequence ownership.
    pub post: Vec<String>,
    /// Columns whose values the database computes (generated columns); a dump must not write them.
    pub skip_columns: Vec<String>,
}

/// One database session that keeps state between statements (`SET FOREIGN_KEY_CHECKS`, ...).
/// Needed where `query()` borrows a different pooled connection each time (MySQL).
#[async_trait]
pub trait Session: Send {
    async fn execute(&mut self, sql: &str) -> Result<u64>;
}

/// `COPY` text format for one row: tab-separated, `\N` for NULL, backslash escapes.
pub fn copy_text_row(row: &[Value], out: &mut String) {
    use std::fmt::Write as _;
    for (i, v) in row.iter().enumerate() {
        if i > 0 {
            out.push('\t');
        }
        match v {
            Value::Null => out.push_str("\\N"),
            Value::Bool(b) => out.push(if *b { 't' } else { 'f' }),
            Value::I64(n) => {
                let _ = write!(out, "{n}");
            }
            Value::F64(f) => {
                let _ = write!(out, "{f}");
            }
            Value::Text(s) => {
                for ch in s.chars() {
                    match ch {
                        '\\' => out.push_str("\\\\"),
                        '\t' => out.push_str("\\t"),
                        '\n' => out.push_str("\\n"),
                        '\r' => out.push_str("\\r"),
                        c => out.push(c),
                    }
                }
            }
            Value::Bytes(b) => {
                out.push_str("\\\\x");
                for x in b {
                    let _ = write!(out, "{x:02x}");
                }
            }
        }
    }
    out.push('\n');
}

/// A staged edit to one row, identified by its primary-key values.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Change {
    Update { key: Vec<(String, Value)>, set: Vec<(String, Value)> },
    Insert { set: Vec<(String, Value)> },
    Delete { key: Vec<(String, Value)> },
}

/// Turn staged changes into dialect SQL plus the affected-row count each statement must produce.
pub fn build_dml(conn: &dyn Connection, schema: Option<&str>, table: &str, changes: &[Change]) -> Vec<(String, Option<u64>)> {
    let t = match schema {
        Some(s) => format!("{}.{}", conn.quote(s), conn.quote(table)),
        None => conn.quote(table),
    };
    let wh = |key: &[(String, Value)]| {
        key.iter()
            .map(|(c, v)| if *v == Value::Null { format!("{} IS NULL", conn.quote(c)) } else { format!("{} = {}", conn.quote(c), conn.literal(v)) })
            .collect::<Vec<_>>()
            .join(" AND ")
    };
    changes
        .iter()
        .map(|c| match c {
            Change::Update { key, set } => {
                let sets = set.iter().map(|(c, v)| format!("{} = {}", conn.quote(c), conn.literal(v))).collect::<Vec<_>>().join(", ");
                (format!("UPDATE {t} SET {sets} WHERE {};", wh(key)), Some(1))
            }
            Change::Delete { key } => (format!("DELETE FROM {t} WHERE {};", wh(key)), Some(1)),
            Change::Insert { set } if set.is_empty() => (format!("INSERT INTO {t} DEFAULT VALUES;"), Some(1)),
            Change::Insert { set } => {
                let cols = set.iter().map(|(c, _)| conn.quote(c)).collect::<Vec<_>>().join(", ");
                let vals = set.iter().map(|(_, v)| conn.literal(v)).collect::<Vec<_>>().join(", ");
                (format!("INSERT INTO {t} ({cols}) VALUES ({vals});"), Some(1))
            }
        })
        .collect()
}


/// A staged edit to a table's structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StructChange {
    AddColumn { name: String, type_name: String, nullable: bool, default: Option<String> },
    DropColumn { name: String },
    RenameColumn { from: String, to: String },
    /// Replace a column's type / nullability / default (the full new definition).
    AlterColumn { name: String, type_name: String, nullable: bool, default: Option<String>, old_type: String, old_nullable: bool, old_default: Option<String> },
    CreateIndex { name: String, columns: Vec<String>, unique: bool },
    DropIndex { name: String },
}

/// Generate dialect-specific DDL for structure edits. Errors name the dialect's limitation.
pub fn build_ddl(conn: &dyn Connection, schema: Option<&str>, table: &str, changes: &[StructChange]) -> Result<Vec<String>> {
    let d = conn.dialect();
    let q = |s: &str| conn.quote(s);
    let t = match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", q(s), q(table)),
        _ => q(table),
    };
    let def_clause = |default: &Option<String>| match default.as_deref().map(str::trim).filter(|x| !x.is_empty()) {
        Some(x) => format!(" DEFAULT {x}"),
        None => String::new(),
    };
    let null_clause = |nullable: bool| if nullable { "" } else { " NOT NULL" };
    let mut out = Vec::new();
    for c in changes {
        match c {
            StructChange::AddColumn { name, type_name, nullable, default } => {
                let col = format!("{} {}{}{}", q(name), type_name, def_clause(default), null_clause(*nullable));
                out.push(if d == "mssql" { format!("ALTER TABLE {t} ADD {col};") } else { format!("ALTER TABLE {t} ADD COLUMN {col};") });
            }
            StructChange::DropColumn { name } => out.push(if d == "mssql" { format!("ALTER TABLE {t} DROP COLUMN {};", q(name)) } else { format!("ALTER TABLE {t} DROP COLUMN {};", q(name)) }),
            StructChange::RenameColumn { from, to } => out.push(match d {
                "mssql" => format!("EXEC sp_rename N'{}.{}', N'{}', N'COLUMN';", t.replace('\'', "''"), from.replace('\'', "''"), to.replace('\'', "''")),
                _ => format!("ALTER TABLE {t} RENAME COLUMN {} TO {};", q(from), q(to)),
            }),
            StructChange::AlterColumn { name, type_name, nullable, default, old_type, old_nullable, old_default } => {
                let (type_changed, null_changed, def_changed) = (type_name != old_type, nullable != old_nullable, default.as_deref().unwrap_or("").trim() != old_default.as_deref().unwrap_or("").trim());
                match d {
                    "sqlite" => return Err(DbError::msg("SQLite cannot alter an existing column's type, nullability or default; add a new column or recreate the table")),
                    "postgres" => {
                        if type_changed {
                            out.push(format!("ALTER TABLE {t} ALTER COLUMN {} TYPE {type_name} USING {}::{type_name};", q(name), q(name)));
                        }
                        if null_changed {
                            out.push(format!("ALTER TABLE {t} ALTER COLUMN {} {} NOT NULL;", q(name), if *nullable { "DROP" } else { "SET" }));
                        }
                        if def_changed {
                            out.push(match default.as_deref().map(str::trim).filter(|x| !x.is_empty()) {
                                Some(x) => format!("ALTER TABLE {t} ALTER COLUMN {} SET DEFAULT {x};", q(name)),
                                None => format!("ALTER TABLE {t} ALTER COLUMN {} DROP DEFAULT;", q(name)),
                            });
                        }
                    }
                    "mysql" => out.push(format!("ALTER TABLE {t} MODIFY COLUMN {} {}{}{};", q(name), type_name, null_clause(*nullable), def_clause(default))),
                    "mssql" => {
                        if def_changed {
                            return Err(DbError::msg("SQL Server defaults are named constraints; change the default with a custom ALTER TABLE"));
                        }
                        out.push(format!("ALTER TABLE {t} ALTER COLUMN {} {}{};", q(name), type_name, null_clause(*nullable)));
                    }
                    other => return Err(DbError::msg(format!("altering columns is not supported for {other}"))),
                }
            }
            StructChange::CreateIndex { name, columns, unique } => {
                if columns.is_empty() {
                    return Err(DbError::msg("an index needs at least one column"));
                }
                out.push(format!("CREATE {}INDEX {} ON {t} ({});", if *unique { "UNIQUE " } else { "" }, q(name), columns.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ")));
            }
            StructChange::DropIndex { name } => out.push(match d {
                "mysql" | "mssql" => format!("DROP INDEX {} ON {t};", q(name)),
                "postgres" => format!("DROP INDEX {};", match schema { Some(s) if !s.is_empty() => format!("{}.{}", q(s), q(name)), _ => q(name) }),
                _ => format!("DROP INDEX {};", q(name)),
            }),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod ddl_tests {
    use super::*;

    struct Fake(&'static str);
    #[async_trait]
    impl Connection for Fake {
        fn dialect(&self) -> &'static str { self.0 }
        fn quote(&self, i: &str) -> String {
            match self.0 { "mysql" => format!("`{i}`"), "mssql" => format!("[{i}]"), _ => format!("\"{i}\"") }
        }
        async fn ping(&self) -> Result<()> { Ok(()) }
        async fn objects(&self) -> Result<Vec<ObjectRef>> { Ok(vec![]) }
        async fn describe(&self, _: Option<&str>, _: &str) -> Result<ObjectInfo> { Ok(ObjectInfo::default()) }
        async fn query(&self, _: &str) -> Result<QueryResult> { Ok(QueryResult::default()) }
    }

    fn add() -> StructChange { StructChange::AddColumn { name: "age".into(), type_name: "INT".into(), nullable: false, default: Some("0".into()) } }
    fn alter() -> StructChange {
        StructChange::AlterColumn { name: "age".into(), type_name: "BIGINT".into(), nullable: true, default: None, old_type: "INT".into(), old_nullable: false, old_default: Some("0".into()) }
    }

    #[test]
    fn add_drop_rename_per_dialect() {
        let ch = [add(), StructChange::RenameColumn { from: "age".into(), to: "years".into() }, StructChange::DropColumn { name: "years".into() }];
        assert_eq!(build_ddl(&Fake("postgres"), Some("public"), "t", &ch).unwrap(), [
            "ALTER TABLE \"public\".\"t\" ADD COLUMN \"age\" INT DEFAULT 0 NOT NULL;",
            "ALTER TABLE \"public\".\"t\" RENAME COLUMN \"age\" TO \"years\";",
            "ALTER TABLE \"public\".\"t\" DROP COLUMN \"years\";"]);
        let my = build_ddl(&Fake("mysql"), None, "t", &ch).unwrap();
        assert_eq!(my[0], "ALTER TABLE `t` ADD COLUMN `age` INT DEFAULT 0 NOT NULL;");
        let ms = build_ddl(&Fake("mssql"), Some("dbo"), "t", &ch).unwrap();
        assert_eq!(ms[0], "ALTER TABLE [dbo].[t] ADD [age] INT DEFAULT 0 NOT NULL;");
        assert_eq!(ms[1], "EXEC sp_rename N'[dbo].[t].age', N'years', N'COLUMN';");
    }

    #[test]
    fn alter_column_per_dialect() {
        assert_eq!(build_ddl(&Fake("postgres"), None, "t", &[alter()]).unwrap(), [
            "ALTER TABLE \"t\" ALTER COLUMN \"age\" TYPE BIGINT USING \"age\"::BIGINT;",
            "ALTER TABLE \"t\" ALTER COLUMN \"age\" DROP NOT NULL;",
            "ALTER TABLE \"t\" ALTER COLUMN \"age\" DROP DEFAULT;"]);
        assert_eq!(build_ddl(&Fake("mysql"), None, "t", &[alter()]).unwrap(), ["ALTER TABLE `t` MODIFY COLUMN `age` BIGINT;"]);
        assert!(build_ddl(&Fake("sqlite"), None, "t", &[alter()]).unwrap_err().to_string().contains("SQLite cannot alter"));
        // Only changed aspects are emitted on Postgres.
        let only_null = StructChange::AlterColumn { name: "a".into(), type_name: "INT".into(), nullable: false, default: None, old_type: "INT".into(), old_nullable: true, old_default: None };
        assert_eq!(build_ddl(&Fake("postgres"), None, "t", &[only_null]).unwrap().len(), 1);
    }

    #[test]
    fn indexes_per_dialect() {
        let ci = StructChange::CreateIndex { name: "ix".into(), columns: vec!["a".into(), "b".into()], unique: true };
        let di = StructChange::DropIndex { name: "ix".into() };
        assert_eq!(build_ddl(&Fake("postgres"), Some("s"), "t", &[ci.clone(), di.clone()]).unwrap(), ["CREATE UNIQUE INDEX \"ix\" ON \"s\".\"t\" (\"a\", \"b\");", "DROP INDEX \"s\".\"ix\";"]);
        assert_eq!(build_ddl(&Fake("mysql"), None, "t", &[di.clone()]).unwrap(), ["DROP INDEX `ix` ON `t`;"]);
        assert_eq!(build_ddl(&Fake("sqlite"), None, "t", &[di]).unwrap(), ["DROP INDEX \"ix\";"]);
        assert!(build_ddl(&Fake("sqlite"), None, "t", &[StructChange::CreateIndex { name: "x".into(), columns: vec![], unique: false }]).is_err());
    }
}

#[cfg(test)]
mod select_tests {
    use super::*;
    struct Fake(&'static str);
    #[async_trait]
    impl Connection for Fake {
        fn dialect(&self) -> &'static str { self.0 }
        fn quote(&self, i: &str) -> String { if self.0 == "mysql" { format!("`{i}`") } else { format!("\"{i}\"") } }
        async fn ping(&self) -> Result<()> { Ok(()) }
        async fn objects(&self) -> Result<Vec<ObjectRef>> { Ok(vec![]) }
        async fn describe(&self, _: Option<&str>, _: &str) -> Result<ObjectInfo> { Ok(ObjectInfo::default()) }
        async fn query(&self, _: &str) -> Result<QueryResult> { Ok(QueryResult::default()) }
    }
    #[test]
    fn select_rows_builds_filter_and_order() {
        let c = Fake("postgres");
        assert_eq!(c.select_rows(None, "t", None, None, 10), "SELECT * FROM \"t\" LIMIT 10");
        assert_eq!(c.select_rows(Some("s"), "t", Some("a > 1"), Some("\"a\" DESC, \"b\" ASC"), 10), "SELECT * FROM \"s\".\"t\" WHERE a > 1 ORDER BY \"a\" DESC, \"b\" ASC LIMIT 10");
        assert_eq!(c.select_rows(None, "t", Some("  "), Some(""), 5), "SELECT * FROM \"t\" LIMIT 5", "blank fragments are ignored");
    }

    #[test]
    fn select_where_uses_the_dialect_quoting() {
        assert_eq!(Fake("postgres").select_where(Some("s"), "t", "a = 1", 50), "SELECT * FROM \"s\".\"t\" WHERE a = 1 LIMIT 50");
        assert_eq!(Fake("mysql").select_where(None, "t", "a = 1", 50), "SELECT * FROM `t` WHERE a = 1 LIMIT 50");
    }
}
