use async_trait::async_trait;
use dbcore::*;
use rusqlite::types::ValueRef;
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub struct SqliteDriver;

struct SqliteConn(Arc<Mutex<rusqlite::Connection>>, rusqlite::InterruptHandle);

#[async_trait]
impl Driver for SqliteDriver {
    fn kind(&self) -> &'static str {
        "sqlite"
    }
    async fn connect(&self, cfg: &ConnConfig) -> Result<Arc<dyn Connection>> {
        let path = cfg.path.clone().unwrap_or_else(|| ":memory:".into());
        let c = rusqlite::Connection::open(path).map_err(DbError::msg)?;
        let h = c.get_interrupt_handle();
        Ok(Arc::new(SqliteConn(Arc::new(Mutex::new(c)), h)))
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
    async fn query_batches(&self, sql: &str, batch_rows: usize, sink: &mut RowSink) -> Result<u64> {
        type Msg = Result<(Vec<ColumnMeta>, Vec<Vec<Value>>)>;
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Msg>(4);
        let (conn, sql) = (self.0.clone(), sql.to_string());
        let producer = tokio::task::spawn_blocking(move || {
            let c = conn.lock().unwrap();
            let run = || -> Result<()> {
                let mut stmt = c.prepare(&sql).map_err(DbError::msg)?;
                let n = stmt.column_count();
                let columns: Vec<ColumnMeta> = stmt.columns().iter().map(|c| ColumnMeta { name: c.name().to_string(), type_name: c.decl_type().unwrap_or("").to_string() }).collect();
                let mut rows = stmt.query([]).map_err(DbError::msg)?;
                let mut batch = Vec::with_capacity(batch_rows);
                while let Some(row) = rows.next().map_err(DbError::msg)? {
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
                    batch.push(out);
                    if batch.len() >= batch_rows {
                        if tx.blocking_send(Ok((columns.clone(), std::mem::take(&mut batch)))).is_err() {
                            return Ok(()); // consumer stopped
                        }
                    }
                }
                let _ = tx.blocking_send(Ok((columns, batch)));
                Ok(())
            };
            if let Err(e) = run() {
                let _ = tx.blocking_send(Err(e));
            }
        });
        let mut total = 0u64;
        while let Some(msg) = rx.recv().await {
            let (cols, rows) = msg?;
            total += rows.len() as u64;
            if !sink(&cols, rows)? {
                break;
            }
        }
        drop(rx);
        let _ = producer.await;
        Ok(total)
    }
    async fn cancel(&self) -> Result<()> {
        self.1.interrupt();
        Ok(())
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
    async fn explain(&self, sql: &str, _analyze: bool) -> Result<PlanNode> {
        let r = self.query(&format!("EXPLAIN QUERY PLAN {sql}")).await?;
        // Rows are (id, parent, notused, detail); parent 0 is the root.
        let rows: Vec<(i64, i64, String)> = r
            .rows
            .iter()
            .map(|r| (if let Value::I64(i) = r[0] { i } else { 0 }, if let Value::I64(i) = r[1] { i } else { 0 }, r[3].display()))
            .collect();
        fn build(parent: i64, rows: &[(i64, i64, String)]) -> Vec<PlanNode> {
            rows.iter()
                .filter(|r| r.1 == parent)
                .map(|(id, _, d)| {
                    let op = d.split_whitespace().next().unwrap_or("").to_string();
                    let relation = d.split(" TABLE ").nth(1).and_then(|t| t.split_whitespace().next()).map(String::from);
                    PlanNode { op, detail: d.clone(), relation, children: build(*id, rows), ..Default::default() }
                })
                .collect()
        }
        Ok(PlanNode { op: "Query".into(), children: build(0, &rows), ..Default::default() })
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
        let c = SqliteDriver.connect(&ConnConfig { kind: "sqlite".into(), ..Default::default() }).await.unwrap();
        c.query("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL)").await.unwrap();
        let r = c.query("INSERT INTO t(name) VALUES ('a'),('b')").await.unwrap();
        assert_eq!(r.affected, Some(2));
        let r = c.query("SELECT * FROM t ORDER BY id").await.unwrap();
        assert_eq!(r.rows.len(), 2);
        assert_eq!(c.objects().await.unwrap()[0].name, "t");
        let d = c.describe(None, "t").await.unwrap();
        assert!(d.columns[0].primary_key && !d.columns[1].nullable);
    }

    #[tokio::test]
    async fn explain_shows_scan_vs_index() {
        let c = SqliteDriver.connect(&ConnConfig { kind: "sqlite".into(), ..Default::default() }).await.unwrap();
        c.query("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)").await.unwrap();
        let scan = c.explain("SELECT * FROM t WHERE name = 'a'", false).await.unwrap();
        assert!(scan.children[0].detail.starts_with("SCAN"), "{:?}", scan.children[0].detail);
        c.query("CREATE INDEX t_name ON t(name)").await.unwrap();
        let idx = c.explain("SELECT * FROM t WHERE name = 'a'", false).await.unwrap();
        assert!(idx.children[0].detail.contains("USING"), "{:?}", idx.children[0].detail);
    }

    #[tokio::test]
    async fn staged_changes_apply_atomically() {
        let c = SqliteDriver.connect(&ConnConfig { kind: "sqlite".into(), ..Default::default() }).await.unwrap();
        c.query("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)").await.unwrap();
        c.query("INSERT INTO t VALUES (1,'a'),(2,'b')").await.unwrap();
        let key = |i| vec![("id".to_string(), Value::I64(i))];
        let good = [
            Change::Update { key: key(1), set: vec![("name".into(), Value::Text("it's".into()))] },
            Change::Insert { set: vec![("name".into(), Value::Null)] },
            Change::Delete { key: key(2) },
        ];
        let stmts = build_dml(c.as_ref(), None, "t", &good);
        assert_eq!(stmts[0].0, "UPDATE \"t\" SET \"name\" = 'it''s' WHERE \"id\" = 1;");
        c.execute_batch(&stmts).await.unwrap();
        let r = c.query("SELECT id, name FROM t ORDER BY id").await.unwrap();
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.rows[0][1], Value::Text("it's".into()));
        // A change that matches no row must roll the whole batch back.
        let bad = [
            Change::Update { key: key(1), set: vec![("name".into(), Value::Text("zzz".into()))] },
            Change::Delete { key: key(99) },
        ];
        assert!(c.execute_batch(&build_dml(c.as_ref(), None, "t", &bad)).await.is_err());
        let r = c.query("SELECT name FROM t WHERE id = 1").await.unwrap();
        assert_eq!(r.rows[0][0], Value::Text("it's".into()));
    }

    #[tokio::test]
    async fn cancel_interrupts_long_query() {
        let c = SqliteDriver.connect(&ConnConfig { kind: "sqlite".into(), ..Default::default() }).await.unwrap();
        let c2 = c.clone();
        let started = std::time::Instant::now();
        let long = tokio::spawn(async move {
            c2.query("WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT count(*) FROM r").await
        });
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        c.cancel().await.unwrap();
        let res = long.await.unwrap();
        assert!(res.is_err(), "query should have been interrupted");
        assert!(started.elapsed().as_secs() < 5);
        // The connection stays usable afterwards.
        assert_eq!(c.query("SELECT 1").await.unwrap().rows.len(), 1);
    }
}
