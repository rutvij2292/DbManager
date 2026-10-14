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
pub struct ObjectInfo {
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<String>,
    pub ddl: Option<String>,
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
    async fn describe(&self, schema: Option<&str>, name: &str) -> Result<ObjectInfo>;
    async fn query(&self, sql: &str) -> Result<QueryResult>;
    /// Abort whatever is currently running on this connection (best effort; no-op if idle).
    async fn cancel(&self) -> Result<()> {
        Err(DbError::msg("cancel is not supported for this driver"))
    }
    /// Query plan for `sql`; `analyze` actually executes it where supported.
    async fn explain(&self, _sql: &str, _analyze: bool) -> Result<PlanNode> {
        Err(DbError::msg("EXPLAIN is not supported for this driver"))
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
        self.query("BEGIN").await?;
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
