use async_trait::async_trait;
use dbcore::*;
use std::sync::Arc;
use std::time::Instant;
use tokio_postgres::{Client, NoTls, SimpleQueryMessage};

/// PostgreSQL-protocol driver (also used for CockroachDB, Redshift, Greenplum).
pub struct PostgresDriver;

struct PgConn(Client);

#[async_trait]
impl Driver for PostgresDriver {
    fn kind(&self) -> &'static str {
        "postgres"
    }
    async fn connect(&self, cfg: &ConnConfig) -> Result<Arc<dyn Connection>> {
        let mut c = tokio_postgres::Config::new();
        c.host(cfg.host.as_deref().unwrap_or("127.0.0.1"));
        c.port(cfg.port.unwrap_or(5432));
        c.user(cfg.user.as_deref().unwrap_or("postgres"));
        if let Some(p) = &cfg.password {
            c.password(p);
        }
        if let Some(d) = &cfg.database {
            c.dbname(d);
        }
        c.connect_timeout(std::time::Duration::from_secs(10));
        let (client, connection) = c.connect(NoTls).await.map_err(DbError::msg)?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(Arc::new(PgConn(client)))
    }
}

fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn convert(type_name: &str, v: Option<&str>) -> Value {
    let Some(s) = v else { return Value::Null };
    match type_name {
        "int2" | "int4" | "int8" => s.parse().map(Value::I64).unwrap_or_else(|_| Value::Text(s.into())),
        "float4" | "float8" => s.parse().map(Value::F64).unwrap_or_else(|_| Value::Text(s.into())),
        "bool" => Value::Bool(s == "t"),
        _ => Value::Text(s.into()),
    }
}

#[async_trait]
impl Connection for PgConn {
    fn dialect(&self) -> &'static str {
        "postgres"
    }
    async fn ping(&self) -> Result<()> {
        self.0.simple_query("SELECT 1").await.map(|_| ()).map_err(DbError::msg)
    }
    async fn objects(&self) -> Result<Vec<ObjectRef>> {
        let r = self.query("SELECT table_schema, table_name, CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2").await?;
        Ok(r.rows.iter().map(|r| ObjectRef { schema: Some(r[0].display()), name: r[1].display(), kind: r[2].display() }).collect())
    }
    async fn describe(&self, schema: Option<&str>, name: &str) -> Result<ObjectInfo> {
        let schema = schema.unwrap_or("public");
        let cols = self.query(&format!(
            "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, \
             EXISTS (SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage k \
               ON tc.constraint_name = k.constraint_name AND tc.table_schema = k.table_schema \
               WHERE tc.constraint_type = 'PRIMARY KEY' AND k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = c.column_name) \
             FROM information_schema.columns c WHERE c.table_schema = {} AND c.table_name = {} ORDER BY c.ordinal_position",
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
                primary_key: r[4] == Value::Bool(true),
            })
            .collect();
        let idx = self.query(&format!("SELECT indexname FROM pg_indexes WHERE schemaname = {} AND tablename = {}", lit(schema), lit(name))).await?;
        Ok(ObjectInfo { columns, indexes: idx.rows.iter().map(|r| r[0].display()).collect(), ddl: None })
    }
    async fn query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        // Column type names come from a prepare; this fails for multi-statement text, which is fine.
        let types: Vec<String> = match self.0.prepare(sql).await {
            Ok(st) => st.columns().iter().map(|c| c.type_().name().to_string()).collect(),
            Err(_) => vec![],
        };
        let msgs = self.0.simple_query(sql).await.map_err(DbError::msg)?;
        let mut res = QueryResult::default();
        for m in msgs {
            match m {
                SimpleQueryMessage::Row(row) => {
                    if res.columns.is_empty() {
                        res.columns = row
                            .columns()
                            .iter()
                            .enumerate()
                            .map(|(i, c)| ColumnMeta { name: c.name().to_string(), type_name: types.get(i).cloned().unwrap_or_default() })
                            .collect();
                    }
                    res.rows.push((0..row.len()).map(|i| convert(types.get(i).map(String::as_str).unwrap_or(""), row.get(i))).collect());
                }
                SimpleQueryMessage::CommandComplete(n) => {
                    if res.columns.is_empty() {
                        res.affected = Some(n);
                    }
                }
                _ => {}
            }
        }
        if res.columns.is_empty() && !types.is_empty() {
            res.columns = types.iter().map(|t| ColumnMeta { name: String::new(), type_name: t.clone() }).collect();
            res.affected = None;
        }
        res.elapsed_ms = start.elapsed().as_millis();
        Ok(res)
    }
    async fn schema_map(&self) -> Result<Vec<SchemaTable>> {
        let r = self.query("SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name, ordinal_position").await?;
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
