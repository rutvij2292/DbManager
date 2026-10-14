use async_trait::async_trait;
use dbcore::*;
use rusqlite::types::ValueRef;
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub struct SqliteDriver;

struct SqliteConn(Arc<Mutex<rusqlite::Connection>>);

#[async_trait]
impl Driver for SqliteDriver {
    fn kind(&self) -> &'static str {
        "sqlite"
    }
    async fn connect(&self, cfg: &ConnConfig) -> Result<Arc<dyn Connection>> {
        let path = cfg.path.clone().unwrap_or_else(|| ":memory:".into());
        let c = rusqlite::Connection::open(path).map_err(DbError::msg)?;
        Ok(Arc::new(SqliteConn(Arc::new(Mutex::new(c)))))
    }
}

fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn run(c: &rusqlite::Connection, sql: &str) -> Result<QueryResult> {
    let start = Instant::now();
    let mut stmt = c.prepare(sql).map_err(DbError::msg)?;
    let n = stmt.column_count();
    if n == 0 {
        let affected = stmt.execute([]).map_err(DbError::msg)? as u64;
        return Ok(QueryResult { affected: Some(affected), elapsed_ms: start.elapsed().as_millis(), ..Default::default() });
    }
    let columns: Vec<ColumnMeta> = stmt
        .columns()
        .iter()
        .map(|c| ColumnMeta { name: c.name().to_string(), type_name: c.decl_type().unwrap_or("").to_string() })
        .collect();
    let mut rows = Vec::new();
    let mut r = stmt.query([]).map_err(DbError::msg)?;
    while let Some(row) = r.next().map_err(DbError::msg)? {
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            out.push(match row.get_ref(i).map_err(DbError::msg)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(i) => Value::I64(i),
                ValueRef::Real(f) => Value::F64(f),
                ValueRef::Text(t) => Value::Text(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(b) => Value::Bytes(b.to_vec()),
            });
        }
        rows.push(out);
    }
    Ok(QueryResult { columns, rows, affected: None, elapsed_ms: start.elapsed().as_millis() })
}

#[async_trait]
impl Connection for SqliteConn {
    fn dialect(&self) -> &'static str {
        "sqlite"
    }
    async fn ping(&self) -> Result<()> {
        self.query("SELECT 1").await.map(|_| ())
    }
    async fn objects(&self) -> Result<Vec<ObjectRef>> {
        let r = self.query("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").await?;
        Ok(r.rows.iter().map(|row| ObjectRef { schema: None, name: row[0].display(), kind: row[1].display() }).collect())
    }
    async fn describe(&self, _schema: Option<&str>, name: &str) -> Result<ObjectInfo> {
        let cols = self.query(&format!("PRAGMA table_info({})", quote_ident(name))).await?;
        let columns = cols
            .rows
            .iter()
            .map(|r| ColumnInfo {
                name: r[1].display(),
                type_name: r[2].display(),
                nullable: r[3] == Value::I64(0),
                primary_key: r[5] != Value::I64(0),
                default: if r[4] == Value::Null { None } else { Some(r[4].display()) },
            })
            .collect();
        let idx = self.query(&format!("PRAGMA index_list({})", quote_ident(name))).await?;
        let indexes = idx.rows.iter().map(|r| r[1].display()).collect();
        let ddl = self
            .query(&format!("SELECT sql FROM sqlite_master WHERE name = '{}'", name.replace('\'', "''")))
            .await?
            .rows
            .first()
            .map(|r| r[0].display());
        Ok(ObjectInfo { columns, indexes, ddl })
    }
    async fn query(&self, sql: &str) -> Result<QueryResult> {
        let conn = self.0.clone();
        let sql = sql.to_string();
        tokio::task::spawn_blocking(move || run(&conn.lock().unwrap(), &sql))
            .await
            .map_err(DbError::msg)?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn roundtrip() {
        let c = SqliteDriver.connect(&ConnConfig { kind: "sqlite".into(), path: None, host: None, port: None, user: None, password: None, database: None }).await.unwrap();
        c.query("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL)").await.unwrap();
        let r = c.query("INSERT INTO t(name) VALUES ('a'),('b')").await.unwrap();
        assert_eq!(r.affected, Some(2));
        let r = c.query("SELECT * FROM t ORDER BY id").await.unwrap();
        assert_eq!(r.rows.len(), 2);
        assert_eq!(c.objects().await.unwrap()[0].name, "t");
        let d = c.describe(None, "t").await.unwrap();
        assert!(d.columns[0].primary_key && !d.columns[1].nullable);
    }
}
