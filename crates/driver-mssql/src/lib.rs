use async_trait::async_trait;
use dbcore::*;
use std::sync::Arc;
use std::time::Instant;
use tiberius::{AuthMethod, Client, ColumnData, Config, EncryptionLevel, FromSql};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

/// Microsoft SQL Server driver (TDS).
pub struct MssqlDriver;

struct MsConn(Mutex<Client<Compat<TcpStream>>>);

#[async_trait]
impl Driver for MssqlDriver {
    fn kind(&self) -> &'static str {
        "mssql"
    }
    async fn connect(&self, cfg: &ConnConfig) -> Result<Arc<dyn Connection>> {
        let mut c = Config::new();
        c.host(cfg.host.as_deref().unwrap_or("127.0.0.1"));
        c.port(cfg.port.unwrap_or(1433));
        c.authentication(AuthMethod::sql_server(cfg.user.as_deref().unwrap_or("sa"), cfg.password.as_deref().unwrap_or("")));
        if let Some(d) = cfg.database.as_deref().filter(|d| !d.is_empty()) {
            c.database(d);
        }
        match cfg.ssl.as_deref().unwrap_or("prefer") {
            "disable" => c.encryption(EncryptionLevel::NotSupported),
            "verify" => c.encryption(EncryptionLevel::Required),
            _ => {
                c.encryption(EncryptionLevel::Required);
                c.trust_cert();
            }
        }
        let tcp = tokio::time::timeout(std::time::Duration::from_secs(10), TcpStream::connect(c.get_addr()))
            .await
            .map_err(|_| DbError::msg("connection timed out"))?
            .map_err(DbError::msg)?;
        tcp.set_nodelay(true).ok();
        let client = Client::connect(c, tcp.compat_write()).await.map_err(DbError::msg)?;
        Ok(Arc::new(MsConn(Mutex::new(client))))
    }
}

fn lit(s: &str) -> String {
    format!("N'{}'", s.replace('\'', "''"))
}

fn convert(cd: ColumnData<'static>) -> Value {
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime, DateTime, Utc};
    match &cd {
        ColumnData::U8(v) => v.map(|x| Value::I64(x as i64)),
        ColumnData::I16(v) => v.map(|x| Value::I64(x as i64)),
        ColumnData::I32(v) => v.map(|x| Value::I64(x as i64)),
        ColumnData::I64(v) => v.map(Value::I64),
        ColumnData::F32(v) => v.map(|x| Value::F64(x as f64)),
        ColumnData::F64(v) => v.map(Value::F64),
        ColumnData::Bit(v) => v.map(Value::Bool),
        ColumnData::String(v) => v.as_ref().map(|s| Value::Text(s.to_string())),
        ColumnData::Guid(v) => v.map(|g| Value::Text(g.to_string())),
        ColumnData::Binary(v) => v.as_ref().map(|b| Value::Bytes(b.to_vec())),
        ColumnData::Numeric(v) => v.map(|n| Value::Text(n.to_string())),
        ColumnData::Xml(v) => v.as_ref().map(|x| Value::Text(x.to_string())),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            NaiveDateTime::from_sql(&cd).ok().flatten().map(|d| Value::Text(d.format("%Y-%m-%d %H:%M:%S%.f").to_string()))
        }
        ColumnData::Date(_) => NaiveDate::from_sql(&cd).ok().flatten().map(|d| Value::Text(d.to_string())),
        ColumnData::Time(_) => NaiveTime::from_sql(&cd).ok().flatten().map(|t| Value::Text(t.to_string())),
        ColumnData::DateTimeOffset(_) => DateTime::<Utc>::from_sql(&cd).ok().flatten().map(|d| Value::Text(d.to_rfc3339())),
    }
    .unwrap_or(Value::Null)
}

fn returns_rows(sql: &str) -> bool {
    let first = sql.trim_start().split(|c: char| !c.is_alphanumeric() && c != '_').next().unwrap_or("").to_ascii_lowercase();
    matches!(first.as_str(), "select" | "with" | "exec" | "execute" | "values" | "show" | "sp_help" | "sp_who" | "dbcc")
}

#[async_trait]
impl Connection for MsConn {
    fn dialect(&self) -> &'static str {
        "mssql"
    }
    fn quote(&self, ident: &str) -> String {
        format!("[{}]", ident.replace(']', "]]"))
    }
    fn begin_sql(&self) -> &'static str {
        "BEGIN TRANSACTION"
    }
    fn literal(&self, v: &Value) -> String {
        match v {
            Value::Text(t) => lit(t),
            Value::Bool(b) => if *b { "1" } else { "0" }.into(),
            Value::Null => "NULL".into(),
            Value::I64(i) => i.to_string(),
            Value::F64(f) => f.to_string(),
            Value::Bytes(b) => format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()),
        }
    }
    fn select_all(&self, schema: Option<&str>, name: &str, limit: usize) -> String {
        let t = match schema {
            Some(s) => format!("{}.{}", self.quote(s), self.quote(name)),
            None => self.quote(name),
        };
        format!("SELECT TOP {limit} * FROM {t}")
    }
    async fn ping(&self) -> Result<()> {
        self.query("SELECT 1").await.map(|_| ())
    }
    async fn objects(&self) -> Result<Vec<ObjectRef>> {
        let r = self.query("SELECT TABLE_SCHEMA, TABLE_NAME, CASE TABLE_TYPE WHEN 'VIEW' THEN 'view' ELSE 'table' END FROM INFORMATION_SCHEMA.TABLES ORDER BY 1, 2").await?;
        Ok(r.rows.iter().map(|r| ObjectRef { schema: Some(r[0].display()), name: r[1].display(), kind: r[2].display() }).collect())
    }
    async fn describe(&self, schema: Option<&str>, name: &str) -> Result<ObjectInfo> {
        let schema = schema.unwrap_or("dbo");
        let cols = self.query(&format!(
            "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, \
             CASE WHEN EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k \
               ON tc.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = k.TABLE_SCHEMA \
               WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME) THEN 1 ELSE 0 END \
             FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_SCHEMA = {} AND c.TABLE_NAME = {} ORDER BY c.ORDINAL_POSITION",
            lit(schema), lit(name)
        )).await?;
        let columns = cols
            .rows
            .iter()
            .map(|r| ColumnInfo {
                name: r[0].display(),
                type_name: r[1].display(),
                nullable: r[2].display() == "YES",
                default: if r[3] == Value::Null { None } else { Some(r[3].display()) },
                primary_key: r[4] == Value::I64(1),
            })
            .collect();
        let idx = self.query(&format!("SELECT i.name FROM sys.indexes i WHERE i.object_id = OBJECT_ID({}) AND i.name IS NOT NULL", lit(&format!("{}.{}", self.quote(schema), self.quote(name))))).await?;
        Ok(ObjectInfo { columns, indexes: idx.rows.iter().map(|r| r[0].display()).collect(), ddl: None })
    }
    async fn query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        let mut client = self.0.lock().await;
        let mut out = QueryResult::default();
        if returns_rows(sql) {
            let stream = client.simple_query(sql).await.map_err(DbError::msg)?;
            let sets = stream.into_results().await.map_err(DbError::msg)?;
            if let Some(rows) = sets.into_iter().find(|s| !s.is_empty()) {
                out.columns = rows[0].columns().iter().map(|c| ColumnMeta { name: c.name().to_string(), type_name: format!("{:?}", c.column_type()).to_lowercase() }).collect();
                out.rows = rows.into_iter().map(|r| r.into_iter().map(convert).collect()).collect();
            }
        } else {
            let res = client.execute(sql, &[]).await.map_err(DbError::msg)?;
            out.affected = Some(res.total());
        }
        out.elapsed_ms = start.elapsed().as_millis();
        Ok(out)
    }
    async fn schema_map(&self) -> Result<Vec<SchemaTable>> {
        let r = self.query("SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION").await?;
        let mut out: Vec<SchemaTable> = Vec::new();
        for row in r.rows {
            let (s, t, c) = (row[0].display(), row[1].display(), row[2].display());
            match out.last_mut() {
                Some(l) if l.schema.as_deref() == Some(&s) && l.name == t => l.columns.push(c),
                _ => out.push(SchemaTable { schema: Some(s), name: t, columns: vec![c] }),
            }
        }
        Ok(out)
    }
}
