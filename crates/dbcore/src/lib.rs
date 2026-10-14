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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectInfo {
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<String>,
    pub ddl: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnConfig {
    pub kind: String,
    pub path: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
}

#[async_trait]
pub trait Connection: Send + Sync {
    fn dialect(&self) -> &'static str;
    async fn ping(&self) -> Result<()>;
    async fn objects(&self) -> Result<Vec<ObjectRef>>;
    async fn describe(&self, schema: Option<&str>, name: &str) -> Result<ObjectInfo>;
    async fn query(&self, sql: &str) -> Result<QueryResult>;
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
