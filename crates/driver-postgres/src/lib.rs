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
    match cfg.socket.as_deref().filter(|s| !s.is_empty()) {
        // tokio-postgres takes the socket *directory*; accept either a directory or the socket file.
        Some(sock) => {
            let p = std::path::Path::new(sock);
            c.host_path(if p.is_dir() { p } else { p.parent().unwrap_or(p) });
        }
        None => {
            c.host(cfg.host.as_deref().unwrap_or("127.0.0.1"));
        }
    }
    c.port(cfg.port.unwrap_or(5432));
    c.user(cfg.user.as_deref().unwrap_or("postgres"));
    if let Some(p) = &cfg.password {
        c.password(p);
    }
    // Without a database tokio-postgres would try one named after the user, which often doesn't exist.
    c.dbname(cfg.database.as_deref().filter(|d| !d.is_empty()).unwrap_or("postgres"));
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
    async fn bulk_insert(&self, schema: Option<&str>, table: &str, columns: &[String], rows: &[Vec<Value>]) -> Result<Option<u64>> {
        use futures_util::SinkExt;
        let t = match schema.filter(|s| !s.is_empty()) {
            Some(sc) => format!("{}.{}", self.quote(sc), self.quote(table)),
            None => self.quote(table),
        };
        let stmt = format!("COPY {t} ({}) FROM STDIN WITH (FORMAT text)", columns.iter().map(|c| self.quote(c)).collect::<Vec<_>>().join(", "));
        let mut buf = String::with_capacity(rows.len() * 64);
        for r in rows {
            copy_text_row(r, &mut buf);
        }
        let sink = self.0.copy_in::<_, bytes::Bytes>(&stmt).await.map_err(DbError::msg)?;
        futures_util::pin_mut!(sink);
        sink.send(bytes::Bytes::from(buf)).await.map_err(DbError::msg)?;
        let n = sink.finish().await.map_err(DbError::msg)?;
        Ok(Some(n))
    }
    async fn copy_from_stdin(&self, statement: &str, data: Vec<u8>) -> Result<u64> {
        use futures_util::SinkExt;
        let sink = self.0.copy_in::<_, bytes::Bytes>(statement).await.map_err(DbError::msg)?;
        futures_util::pin_mut!(sink);
        sink.send(bytes::Bytes::from(data)).await.map_err(DbError::msg)?;
        sink.finish().await.map_err(DbError::msg)
    }
    async fn dump_types(&self, schemas: &[String]) -> Result<Vec<String>> {
        let mut out = Vec::new();
        for s in schemas.iter().filter(|s| s.as_str() != "public") {
            out.push(format!("CREATE SCHEMA IF NOT EXISTS {};", self.quote(s)));
        }
        let list = schemas.iter().map(|s| lit(s)).collect::<Vec<_>>().join(", ");
        if list.is_empty() {
            return Ok(out);
        }
        let r = self.query(&format!(
            "SELECT n.nspname, t.typname, string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) \
             FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace \
             WHERE n.nspname IN ({list}) GROUP BY n.nspname, t.typname ORDER BY 1, 2")).await?;
        for row in r.rows {
            out.push(format!("CREATE TYPE {}.{} AS ENUM ({});", self.quote(&row[0].display()), self.quote(&row[1].display()), row[2].display()));
        }
        Ok(out)
    }
    async fn table_ddl(&self, schema: Option<&str>, table: &str) -> Result<TableDdl> {
        let schema = schema.unwrap_or("public");
        let reg = lit(&format!("{}.{}", self.quote(schema), self.quote(table)));
        let t = format!("{}.{}", self.quote(schema), self.quote(table));
        let cols = self.query(&format!(
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity, a.attgenerated \
             FROM pg_attribute a LEFT JOIN pg_attrdef d ON a.attrelid = d.adrelid AND a.attnum = d.adnum \
             WHERE a.attrelid = {reg}::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum")).await?;
        let (mut defs, mut pre, mut post, mut skip) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for r in &cols.rows {
            let (name, ty, notnull, default) = (r[0].display(), r[1].display(), r[2] == Value::Bool(true), if r[3] == Value::Null { None } else { Some(r[3].display()) });
            let (identity, generated) = (r[4].display(), r[5].display());
            let mut def = format!("{} {}", self.quote(&name), ty);
            if generated == "s" {
                def.push_str(&format!(" GENERATED ALWAYS AS ({}) STORED", default.clone().unwrap_or_default()));
                skip.push(name.clone());
            } else if !identity.is_empty() {
                def.push_str(" GENERATED BY DEFAULT AS IDENTITY");
            } else if let Some(d) = &default {
                def.push_str(&format!(" DEFAULT {d}"));
                // serial columns: the sequence has to exist before the table that defaults to it
                if let Some(seq) = d.strip_prefix("nextval('").and_then(|x| x.split("'::regclass").next()) {
                    pre.push(format!("CREATE SEQUENCE IF NOT EXISTS {seq};"));
                    post.push(format!("ALTER SEQUENCE {seq} OWNED BY {t}.{};", self.quote(&name)));
                }
            }
            if notnull && generated != "s" {
                def.push_str(" NOT NULL");
            }
            defs.push(def);
        }
        let cons = self.query(&format!("SELECT conname, contype, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = {reg}::regclass AND contype IN ('p','u','c','f','x') ORDER BY contype = 'f', conname")).await?;
        for r in &cons.rows {
            let (name, kind, def) = (r[0].display(), r[1].display(), r[2].display());
            if kind == "f" {
                post.push(format!("ALTER TABLE ONLY {t} ADD CONSTRAINT {} {def};", self.quote(&name)));
            } else {
                defs.push(format!("CONSTRAINT {} {def}", self.quote(&name)));
            }
        }
        let idx = self.query(&format!(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = {} AND tablename = {} \
             AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE conrelid = {reg}::regclass AND contype IN ('p','u','x')) ORDER BY indexname", lit(schema), lit(table))).await?;
        for r in &idx.rows {
            post.push(format!("{};", r[0].display()));
        }
        Ok(TableDdl { pre, create: format!("CREATE TABLE {t} (\n    {}\n);", defs.join(",\n    ")), post, skip_columns: skip })
    }
    async fn view_ddls(&self) -> Result<Vec<String>> {
        let r = self.query("SELECT schemaname, viewname, definition FROM pg_views WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2").await?;
        Ok(r.rows.iter().map(|row| format!("CREATE OR REPLACE VIEW {}.{} AS\n{}", self.quote(&row[0].display()), self.quote(&row[1].display()), row[2].display().trim())).collect())
    }
    fn dump_prelude(&self) -> Vec<String> {
        vec!["SET client_encoding = 'UTF8';".into(), "SET standard_conforming_strings = on;".into(), "SET check_function_bodies = false;".into()]
    }
    fn sequence_resets(&self, schema: Option<&str>, table: &str, ddl: &TableDdl) -> Vec<String> {
        // One setval per serial/identity column, computed from the restored data.
        // (pg_get_serial_sequence wants the table as a possibly-quoted name but the column as plain text.)
        let t = format!("{}.{}", self.quote(schema.unwrap_or("public")), self.quote(table));
        let cols: Vec<String> = ddl.create.lines().filter(|l| l.contains("nextval(") || l.contains("GENERATED BY DEFAULT AS IDENTITY")).filter_map(|l| l.trim().trim_start_matches('"').split('"').next().map(String::from)).collect();
        cols.iter().map(|c| format!("SELECT pg_catalog.setval(pg_get_serial_sequence({}, {}), COALESCE((SELECT MAX({}) FROM {t}), 1), (SELECT MAX({}) IS NOT NULL FROM {t}));", lit(&t), lit(c), self.quote(c), self.quote(c))).collect()
    }
    async fn native_csv_export(&self, sql: &str, header: bool, delimiter: char, out: &mut (dyn std::io::Write + Send), cancel: &(dyn Fn() -> bool + Send + Sync), progress: &(dyn Fn(u64) + Send + Sync)) -> Result<Option<u64>> {
        use futures_util::TryStreamExt;
        if !delimiter.is_ascii() || delimiter == '"' || delimiter == '\n' || delimiter == '\r' {
            return Ok(None);
        }
        // A private connection: COPY OUT would otherwise block the shared one for its duration.
        let client = connect_client(&self.2).await?.0;
        let body = sql.trim().trim_end_matches(';');
        let stmt = format!("COPY ({body}) TO STDOUT WITH (FORMAT csv, HEADER {}, DELIMITER '{}')", if header { "true" } else { "false" }, delimiter);
        let stream = client.copy_out(&stmt).await.map_err(DbError::msg)?;
        futures_util::pin_mut!(stream);
        // Count records by newlines outside quotes (a doubled quote toggles twice, so it nets out).
        let (mut rows, mut in_quote) = (0u64, false);
        while let Some(chunk) = stream.try_next().await.map_err(DbError::msg)? {
            if cancel() {
                return Err(DbError::Cancelled);
            }
            for &b in chunk.iter() {
                match b {
                    b'"' => in_quote = !in_quote,
                    b'\n' if !in_quote => rows += 1,
                    _ => {}
                }
            }
            out.write_all(&chunk).map_err(DbError::msg)?;
            progress(rows.saturating_sub(header as u64));
        }
        Ok(Some(rows.saturating_sub(header as u64)))
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
    async fn databases(&self) -> Result<Vec<String>> {
        let r = self.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname").await?;
        Ok(r.rows.iter().map(|r| r[0].display()).collect())
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
        let ixs = self.query(&format!(
            "SELECT i.relname, ix.indisunique, ix.indisprimary, \
               (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) \
             FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace \
             WHERE n.nspname = {} AND t.relname = {} ORDER BY i.relname", lit(schema), lit(name))).await?;
        let index_details = ixs.rows.iter().map(|r| IndexInfo { name: r[0].display(), columns: r[3].display().split(',').map(String::from).collect(), unique: r[1] == Value::Bool(true), primary: r[2] == Value::Bool(true) }).collect();
        let fks = self.query(&format!(
            "SELECT c.conname, \
               (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum), \
               rn.nspname, rt.relname, \
               (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) \
             FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace \
               JOIN pg_class rt ON rt.oid = c.confrelid JOIN pg_namespace rn ON rn.oid = rt.relnamespace \
             WHERE c.contype = 'f' AND n.nspname = {} AND t.relname = {} ORDER BY c.conname", lit(schema), lit(name))).await?;
        let foreign_keys = fks.rows.iter().map(|r| ForeignKey {
            name: r[0].display(), columns: r[1].display().split(',').map(String::from).collect(),
            ref_schema: Some(r[2].display()), ref_table: r[3].display(), ref_columns: r[4].display().split(',').map(String::from).collect(),
        }).collect();
        Ok(ObjectInfo { columns, indexes: idx.rows.iter().map(|r| r[0].display()).collect(), ddl: None, index_details, foreign_keys })
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
