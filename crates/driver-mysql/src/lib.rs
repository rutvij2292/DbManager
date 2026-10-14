use async_trait::async_trait;
use dbcore::*;
use mysql_async::{prelude::*, Opts, OptsBuilder, Pool, Value as MyValue};
use std::sync::Arc;
use std::time::Instant;

/// MySQL-protocol driver (also used for MariaDB).
pub struct MysqlDriver;

struct MyConn(Pool);

#[async_trait]
impl Driver for MysqlDriver {
    fn kind(&self) -> &'static str {
        "mysql"
    }
    async fn connect(&self, cfg: &ConnConfig) -> Result<Arc<dyn Connection>> {
        let opts: Opts = OptsBuilder::default()
            .ip_or_hostname(cfg.host.clone().unwrap_or_else(|| "127.0.0.1".into()))
            .tcp_port(cfg.port.unwrap_or(3306))
            .user(cfg.user.clone().or(Some("root".into())))
            .pass(cfg.password.clone())
            .db_name(cfg.database.clone())
            .into();
        Ok(Arc::new(MyConn(Pool::new(opts))))
    }
}

fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
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

#[async_trait]
impl Connection for MyConn {
    fn dialect(&self) -> &'static str {
        "mysql"
    }
    fn quote(&self, ident: &str) -> String {
        format!("`{}`", ident.replace('`', "``"))
    }
    async fn ping(&self) -> Result<()> {
        self.query("SELECT 1").await.map(|_| ())
    }
    async fn objects(&self) -> Result<Vec<ObjectRef>> {
        let r = self.query("SELECT table_schema, table_name, IF(table_type = 'VIEW', 'view', 'table') FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name").await?;
        Ok(r.rows.iter().map(|r| ObjectRef { schema: None, name: r[1].display(), kind: r[2].display() }).collect())
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
        Ok(ObjectInfo { columns, indexes: idx.rows.iter().map(|r| r[0].display()).collect(), ddl })
    }
    async fn query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        let mut conn = self.0.get_conn().await.map_err(DbError::msg)?;
        let mut result = conn.query_iter(sql).await.map_err(DbError::msg)?;
        let mut out = QueryResult::default();
        out.columns = result.columns_ref().iter().map(|c| ColumnMeta { name: c.name_str().into_owned(), type_name: format!("{:?}", c.column_type()).trim_start_matches("MYSQL_TYPE_").to_lowercase() }).collect();
        if out.columns.is_empty() {
            out.affected = Some(result.affected_rows());
        } else {
            let rows: Vec<mysql_async::Row> = result.collect().await.map_err(DbError::msg)?;
            out.rows = rows.into_iter().map(|r| r.unwrap().into_iter().map(convert).collect()).collect();
        }
        out.elapsed_ms = start.elapsed().as_millis();
        Ok(out)
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
