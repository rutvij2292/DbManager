use async_trait::async_trait;
use dbcore::*;
use mysql_async::consts::ColumnType;
use mysql_async::{prelude::*, Opts, OptsBuilder, Pool, SslOpts, Value as MyValue};
use std::sync::Arc;
use std::time::Instant;

/// MySQL-protocol driver (also used for MariaDB).
pub struct MysqlDriver;

struct MyConn {
    pool: Pool,
    /// Server thread ids of queries currently running on this connection, for KILL QUERY.
    running: std::sync::Mutex<Vec<u32>>,
}

#[async_trait]
impl Driver for MysqlDriver {
    fn kind(&self) -> &'static str {
        "mysql"
    }
    async fn connect(&self, cfg: &ConnConfig) -> Result<Arc<dyn Connection>> {
        let ssl = match cfg.ssl.as_deref().unwrap_or("prefer") {
            "disable" | "prefer" => None, // MySQL has no cheap "try TLS then fall back"; opt in with require/verify
            "verify" => Some(SslOpts::default()),
            _ => Some(SslOpts::default().with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true)),
        };
        let opts: Opts = OptsBuilder::default()
            .ssl_opts(if cfg.socket.is_some() { None } else { ssl })
            .socket(cfg.socket.clone().filter(|s| !s.is_empty()))
            .ip_or_hostname(cfg.host.clone().unwrap_or_else(|| "127.0.0.1".into()))
            .tcp_port(cfg.port.unwrap_or(3306))
            .user(cfg.user.clone().or(Some("root".into())))
            .pass(cfg.password.clone())
            .db_name(cfg.database.clone())
            .into();
        Ok(Arc::new(MyConn { pool: Pool::new(opts), running: Default::default() }))
    }
}

fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
}

/// The text protocol sends numbers as bytes; use the column type to recover them.
fn convert_col(v: MyValue, ty: ColumnType) -> Value {
    use ColumnType::*;
    match (&v, ty) {
        (MyValue::Bytes(b), MYSQL_TYPE_TINY | MYSQL_TYPE_SHORT | MYSQL_TYPE_LONG | MYSQL_TYPE_LONGLONG | MYSQL_TYPE_INT24 | MYSQL_TYPE_YEAR) => {
            if let Some(n) = std::str::from_utf8(b).ok().and_then(|s| s.parse::<i64>().ok()) {
                return Value::I64(n);
            }
        }
        (MyValue::Bytes(b), MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE) => {
            if let Some(n) = std::str::from_utf8(b).ok().and_then(|s| s.parse::<f64>().ok()) {
                return Value::F64(n);
            }
        }
        _ => {}
    }
    convert(v)
}

fn convert(v: MyValue) -> Value {
    match v {
        MyValue::NULL => Value::Null,
        MyValue::Bytes(b) => match String::from_utf8(b) {
            Ok(s) => Value::Text(s),
            Err(e) => Value::Bytes(e.into_bytes()),
        },
        MyValue::Int(i) => Value::I64(i),
        MyValue::UInt(u) => i64::try_from(u).map(Value::I64).unwrap_or_else(|_| Value::Text(u.to_string())),
        MyValue::Float(f) => Value::F64(f as f64),
        MyValue::Double(d) => Value::F64(d),
        MyValue::Date(y, mo, d, h, mi, s, us) => {
            if h == 0 && mi == 0 && s == 0 && us == 0 {
                Value::Text(format!("{y:04}-{mo:02}-{d:02}"))
            } else {
                Value::Text(format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}"))
            }
        }
        MyValue::Time(neg, d, h, mi, s, _) => Value::Text(format!("{}{:02}:{mi:02}:{s:02}", if neg { "-" } else { "" }, d * 24 + h as u32)),
    }
}

/// One pooled connection held for a whole script so `SET` statements persist.
struct MySession(mysql_async::Conn);

#[async_trait]
impl Session for MySession {
    async fn execute(&mut self, sql: &str) -> Result<u64> {
        self.0.query_drop(sql).await.map_err(DbError::msg)?;
        Ok(self.0.affected_rows())
    }
}

async fn run_on(conn: &mut mysql_async::Conn, sql: &str) -> Result<QueryResult> {
    let mut result = conn.query_iter(sql).await.map_err(DbError::msg)?;
    let mut out = QueryResult::default();
    out.columns = result
        .columns_ref()
        .iter()
        .map(|c| ColumnMeta { name: c.name_str().into_owned(), type_name: format!("{:?}", c.column_type()).trim_start_matches("MYSQL_TYPE_").to_lowercase() })
        .collect();
    if out.columns.is_empty() {
        out.affected = Some(result.affected_rows());
    } else {
        let types: Vec<ColumnType> = result.columns_ref().iter().map(|c| c.column_type()).collect();
        let rows: Vec<mysql_async::Row> = result.collect().await.map_err(DbError::msg)?;
        out.rows = rows.into_iter().map(|r| r.unwrap().into_iter().zip(&types).map(|(v, t)| convert_col(v, *t)).collect()).collect();
    }
    Ok(out)
}

#[async_trait]
impl Connection for MyConn {
    fn dialect(&self) -> &'static str {
        "mysql"
    }
    fn quote(&self, ident: &str) -> String {
        format!("`{}`", ident.replace('`', "``"))
    }
    fn literal(&self, v: &Value) -> String {
        match v {
            Value::Text(t) => lit(t),
            Value::Bool(b) => if *b { "1" } else { "0" }.into(),
            Value::Null => "NULL".into(),
            Value::I64(i) => i.to_string(),
            Value::F64(f) => f.to_string(),
            Value::Bytes(b) => format!("X'{}'", b.iter().map(|x| format!("{x:02x}")).collect::<String>()),
        }
    }
    async fn execute_batch(&self, stmts: &[(String, Option<u64>)]) -> Result<u64> {
        use mysql_async::TxOpts;
        let mut conn = self.pool.get_conn().await.map_err(DbError::msg)?;
        let mut tx = conn.start_transaction(TxOpts::default()).await.map_err(DbError::msg)?;
        let mut total = 0;
        for (sql, expect) in stmts {
            tx.query_drop(sql).await.map_err(DbError::msg)?; // dropping `tx` on error rolls back
            let n = tx.affected_rows();
            if let Some(want) = expect {
                if n != *want {
                    return Err(DbError::msg(format!("rolled back: expected {want} row(s) affected but got {n} for: {sql}")));
                }
            }
            total += n;
        }
        tx.commit().await.map_err(DbError::msg)?;
        Ok(total)
    }
    async fn ping(&self) -> Result<()> {
        self.query("SELECT 1").await.map(|_| ())
    }
    async fn objects(&self) -> Result<Vec<ObjectRef>> {
        let r = self.query("SELECT table_schema, table_name, IF(table_type = 'VIEW', 'view', 'table') FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name").await?;
        Ok(r.rows.iter().map(|r| ObjectRef { schema: None, name: r[1].display(), kind: r[2].display() }).collect())
    }
    async fn databases(&self) -> Result<Vec<String>> {
        let r = self.query("SHOW DATABASES").await?;
        Ok(r.rows.iter().map(|r| r[0].display()).collect())
    }
    async fn describe(&self, _schema: Option<&str>, name: &str) -> Result<ObjectInfo> {
        let cols = self.query(&format!("SELECT column_name, column_type, is_nullable, column_default, column_key FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = {} ORDER BY ordinal_position", lit(name))).await?;
        let columns = cols
            .rows
            .iter()
            .map(|r| ColumnInfo {
                name: r[0].display(),
                type_name: r[1].display(),
                nullable: r[2].display() == "YES",
                default: if r[3] == Value::Null { None } else { Some(r[3].display()) },
                primary_key: r[4].display() == "PRI",
            })
            .collect();
        let idx = self.query(&format!("SELECT DISTINCT index_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = {}", lit(name))).await?;
        let ddl = self.query(&format!("SHOW CREATE TABLE {}", self.quote(name))).await.ok().and_then(|r| r.rows.first().and_then(|row| row.get(1).map(Value::display)));
        let ixs = self.query(&format!("SELECT index_name, non_unique, GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = {} GROUP BY index_name, non_unique ORDER BY index_name", lit(name))).await?;
        let index_details = ixs.rows.iter().map(|r| IndexInfo { name: r[0].display(), columns: r[2].display().split(',').map(String::from).collect(), unique: r[1].display() == "0", primary: r[0].display() == "PRIMARY" }).collect();
        let fks = self.query(&format!("SELECT constraint_name, GROUP_CONCAT(column_name ORDER BY ordinal_position SEPARATOR ','), referenced_table_schema, referenced_table_name, GROUP_CONCAT(referenced_column_name ORDER BY ordinal_position SEPARATOR ',') FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = {} AND referenced_table_name IS NOT NULL GROUP BY constraint_name, referenced_table_schema, referenced_table_name ORDER BY constraint_name", lit(name))).await?;
        let foreign_keys = fks.rows.iter().map(|r| ForeignKey { name: r[0].display(), columns: r[1].display().split(',').map(String::from).collect(), ref_schema: None, ref_table: r[3].display(), ref_columns: r[4].display().split(',').map(String::from).collect() }).collect();
        Ok(ObjectInfo { columns, indexes: idx.rows.iter().map(|r| r[0].display()).collect(), ddl, index_details, foreign_keys })
    }
    async fn query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        let mut conn = self.pool.get_conn().await.map_err(DbError::msg)?;
        let tid = conn.id();
        self.running.lock().unwrap().push(tid);
        let res = run_on(&mut conn, sql).await;
        self.running.lock().unwrap().retain(|t| *t != tid);
        let mut out = res?;
        out.elapsed_ms = start.elapsed().as_millis();
        Ok(out)
    }
    async fn table_ddl(&self, _schema: Option<&str>, table: &str) -> Result<TableDdl> {
        let r = self.query(&format!("SHOW CREATE TABLE {}", self.quote(table))).await?;
        let create = r.rows.first().and_then(|row| row.get(1)).map(Value::display).ok_or_else(|| DbError::msg(format!("table {table} not found")))?;
        // MySQL's definition already contains keys and foreign keys; checks are switched off by the prelude.
        Ok(TableDdl { create: format!("{create};"), ..Default::default() })
    }
    async fn view_ddls(&self) -> Result<Vec<String>> {
        let views = self.query("SELECT table_name FROM information_schema.views WHERE table_schema = DATABASE() ORDER BY table_name").await?;
        let mut out = Vec::new();
        for v in views.rows {
            let r = self.query(&format!("SHOW CREATE VIEW {}", self.quote(&v[0].display()))).await?;
            if let Some(def) = r.rows.first().and_then(|row| row.get(1)) {
                out.push(format!("{};", def.display()));
            }
        }
        Ok(out)
    }
    fn dump_prelude(&self) -> Vec<String> {
        vec!["SET NAMES utf8mb4;".into(), "SET FOREIGN_KEY_CHECKS = 0;".into(), "SET UNIQUE_CHECKS = 0;".into(), "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';".into()]
    }
    fn dump_epilogue(&self) -> Vec<String> {
        vec!["SET UNIQUE_CHECKS = 1;".into(), "SET FOREIGN_KEY_CHECKS = 1;".into()]
    }
    async fn open_session(&self) -> Result<Option<Box<dyn Session>>> {
        let conn = self.pool.get_conn().await.map_err(DbError::msg)?;
        Ok(Some(Box::new(MySession(conn))))
    }
    async fn query_batches(&self, sql: &str, batch_rows: usize, sink: &mut RowSink) -> Result<u64> {
        let mut conn = self.pool.get_conn().await.map_err(DbError::msg)?;
        let tid = conn.id();
        self.running.lock().unwrap().push(tid);
        let res = async {
            let mut result = conn.query_iter(sql).await.map_err(DbError::msg)?;
            let columns: Vec<ColumnMeta> = result.columns_ref().iter().map(|c| ColumnMeta { name: c.name_str().into_owned(), type_name: format!("{:?}", c.column_type()).trim_start_matches("MYSQL_TYPE_").to_lowercase() }).collect();
            let types: Vec<ColumnType> = result.columns_ref().iter().map(|c| c.column_type()).collect();
            let (mut batch, mut total) = (Vec::with_capacity(batch_rows), 0u64);
            let mut stopped = false;
            while let Some(row) = result.next().await.map_err(DbError::msg)? {
                batch.push(row.unwrap().into_iter().zip(&types).map(|(v, t)| convert_col(v, *t)).collect::<Vec<_>>());
                if batch.len() >= batch_rows {
                    total += batch.len() as u64;
                    if !sink(&columns, std::mem::take(&mut batch))? {
                        stopped = true;
                        break;
                    }
                }
            }
            if !stopped {
                total += batch.len() as u64;
                sink(&columns, batch)?;
            } else {
                // Drain so the connection can be reused cleanly.
                drop(result);
            }
            Ok::<u64, DbError>(total)
        }
        .await;
        self.running.lock().unwrap().retain(|t| *t != tid);
        res
    }
    async fn cancel(&self) -> Result<()> {
        let ids: Vec<u32> = self.running.lock().unwrap().clone();
        if ids.is_empty() {
            return Ok(());
        }
        // KILL QUERY must go over a different connection than the one running the query.
        let mut side = self.pool.get_conn().await.map_err(DbError::msg)?;
        for id in ids {
            side.query_drop(format!("KILL QUERY {id}")).await.map_err(DbError::msg)?;
        }
        Ok(())
    }
    async fn explain(&self, sql: &str, _analyze: bool) -> Result<PlanNode> {
        let r = self.query(&format!("EXPLAIN {sql}")).await?;
        let col = |name: &str| r.columns.iter().position(|c| c.name.eq_ignore_ascii_case(name));
        let (t, ty, key, rows, extra) = (col("table"), col("type"), col("key"), col("rows"), col("Extra"));
        let get = |row: &Vec<Value>, i: Option<usize>| i.map(|i| row[i].clone()).unwrap_or(Value::Null);
        let nodes: Vec<PlanNode> = r
            .rows
            .iter()
            .map(|row| {
                let access = get(row, ty).display();
                let key_s = get(row, key);
                PlanNode {
                    op: if access == "ALL" { "Full Table Scan".into() } else { format!("Access {access}") },
                    detail: format!("key: {} · {}", if key_s == Value::Null { "none".into() } else { key_s.display() }, get(row, extra).display()),
                    relation: Some(get(row, t).display()).filter(|s| s != "NULL"),
                    est_rows: match get(row, rows) { Value::I64(n) => Some(n as f64), _ => None },
                    ..Default::default()
                }
            })
            .collect();
        Ok(PlanNode { op: "Query".into(), children: nodes, ..Default::default() })
    }
    async fn schema_map(&self) -> Result<Vec<SchemaTable>> {
        let r = self.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position").await?;
        let mut out: Vec<SchemaTable> = Vec::new();
        for row in r.rows {
            let (t, c) = (row[0].display(), row[1].display());
            match out.last_mut() {
                Some(l) if l.name == t => l.columns.push(c),
                _ => out.push(SchemaTable { schema: None, name: t, columns: vec![c] }),
            }
        }
        Ok(out)
    }
}
