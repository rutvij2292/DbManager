use async_trait::async_trait;
use dbcore::*;
use std::sync::Arc;
use std::time::Instant;
use tokio_postgres::{Client, NoTls, SimpleQueryMessage};
use postgres_native_tls::MakeTlsConnector;

/// PostgreSQL-protocol driver (also used for CockroachDB, Redshift, Greenplum).
pub struct PostgresDriver;

struct PgConn(Client, Option<MakeTlsConnector>, ConnConfig);

#[async_trait]
impl Driver for PostgresDriver {
    fn kind(&self) -> &'static str {
        "postgres"
    }
    async fn connect(&self, cfg: &ConnConfig) -> Result<Arc<dyn Connection>> {
        let (client, used_tls) = connect_client(cfg).await?;
        Ok(Arc::new(PgConn(client, used_tls, cfg.clone())))
    }
}

async fn connect_client(cfg: &ConnConfig) -> Result<(Client, Option<MakeTlsConnector>)> {
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
    let mode = cfg.ssl.as_deref().unwrap_or("prefer");
    let tls = || -> Result<MakeTlsConnector> {
        let b = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(mode != "verify")
            .danger_accept_invalid_hostnames(mode != "verify")
            .build()
            .map_err(DbError::msg)?;
        Ok(MakeTlsConnector::new(b))
    };
    let mut used_tls: Option<MakeTlsConnector> = None;
    let client = match mode {
        "disable" => plain(&c).await?,
        "prefer" => match tls() {
            Ok(t) => match c.connect(t.clone()).await {
                Ok((client, conn)) => { spawn_conn(conn); used_tls = Some(t); client }
                Err(_) => plain(&c).await?, // server without TLS
            },
            Err(_) => plain(&c).await?,
        },
        _ => {
            let t = tls()?;
            let (client, conn) = c.connect(t.clone()).await.map_err(DbError::msg)?;
            spawn_conn(conn);
            used_tls = Some(t);
            client
        }
    };
    Ok((client, used_tls))
}

fn spawn_conn<S, T>(conn: tokio_postgres::Connection<S, T>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let _ = conn.await;
    });
}

async fn plain(c: &tokio_postgres::Config) -> Result<Client> {
    let (client, conn) = c.connect(NoTls).await.map_err(DbError::msg)?;
    spawn_conn(conn);
    Ok(client)
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
    async fn query_batches(&self, sql: &str, batch_rows: usize, sink: &mut RowSink) -> Result<u64> {
        // A cursor needs a transaction; use a private connection so other tabs' queries on the
        // shared client are never pulled into it.
        let client = connect_client(&self.2).await?.0;
        client.batch_execute("BEGIN READ ONLY").await.map_err(DbError::msg)?;
        let body = sql.trim().trim_end_matches(';');
        client.batch_execute(&format!("DECLARE lattice_export NO SCROLL CURSOR FOR {body}")).await.map_err(DbError::msg)?;
        // Column types for typed conversion come from a prepare of the same statement.
        let types: Vec<String> = match client.prepare(body).await {
            Ok(st) => st.columns().iter().map(|c| c.type_().name().to_string()).collect(),
            Err(_) => vec![],
        };
        let mut total = 0u64;
        let mut columns: Vec<ColumnMeta> = Vec::new();
        let mut sent_any = false;
        loop {
            let msgs = client.simple_query(&format!("FETCH FORWARD {batch_rows} FROM lattice_export")).await.map_err(DbError::msg)?;
            let mut rows: Vec<Vec<Value>> = Vec::new();
            for m in msgs {
                if let SimpleQueryMessage::Row(row) = m {
                    if columns.is_empty() {
                        columns = row.columns().iter().enumerate().map(|(i, c)| ColumnMeta { name: c.name().to_string(), type_name: types.get(i).cloned().unwrap_or_default() }).collect();
                    }
                    rows.push((0..row.len()).map(|i| convert(types.get(i).map(String::as_str).unwrap_or(""), row.get(i))).collect());
                }
            }
            if rows.is_empty() {
                break;
            }
            if columns.is_empty() {
                columns = types.iter().map(|t| ColumnMeta { name: String::new(), type_name: t.clone() }).collect();
            }
            total += rows.len() as u64;
            sent_any = true;
            let more = sink(&columns, rows)?;
            if !more {
                break;
            }
        }
        if !sent_any {
            // Empty result: still report the column names.
            if let Ok(st) = client.prepare(body).await {
                let cols: Vec<ColumnMeta> = st.columns().iter().map(|c| ColumnMeta { name: c.name().to_string(), type_name: c.type_().name().to_string() }).collect();
                sink(&cols, vec![])?;
            }
        }
        let _ = client.batch_execute("ROLLBACK").await;
        Ok(total)
    }
    async fn cancel(&self) -> Result<()> {
        let token = self.0.cancel_token();
        match &self.1 {
            Some(t) => token.cancel_query(t.clone()).await,
            None => token.cancel_query(NoTls).await,
        }
        .map_err(DbError::msg)
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
    async fn explain(&self, sql: &str, analyze: bool) -> Result<PlanNode> {
        let opts = if analyze { "ANALYZE, FORMAT JSON" } else { "FORMAT JSON" };
        let r = self.query(&format!("EXPLAIN ({opts}) {sql}")).await?;
        let text = r.rows.first().map(|r| r[0].display()).ok_or_else(|| DbError::msg("empty plan"))?;
        let json: serde_json::Value = serde_json::from_str(&text).map_err(DbError::msg)?;
        fn node(v: &serde_json::Value) -> PlanNode {
            let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
            let f = |k: &str| v.get(k).and_then(|x| x.as_f64());
            let mut detail = Vec::new();
            for k in ["Index Name", "Filter", "Index Cond", "Hash Cond", "Join Type", "Sort Key"] {
                if let Some(x) = v.get(k) {
                    detail.push(format!("{k}: {}", x.as_str().map(String::from).unwrap_or_else(|| x.to_string())));
                }
            }
            let loops = f("Actual Loops").unwrap_or(1.0);
            PlanNode {
                op: s("Node Type").unwrap_or_default(),
                detail: detail.join(" · "),
                relation: s("Relation Name"),
                est_rows: f("Plan Rows"),
                actual_rows: f("Actual Rows").map(|r| r * loops),
                cost: f("Total Cost"),
                time_ms: f("Actual Total Time").map(|t| t * loops),
                children: v.get("Plans").and_then(|p| p.as_array()).map(|a| a.iter().map(node).collect()).unwrap_or_default(),
            }
        }
        let plan = json.get(0).and_then(|p| p.get("Plan")).ok_or_else(|| DbError::msg("unexpected plan format"))?;
        Ok(node(plan))
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
