use async_trait::async_trait;
use dbcore::*;
use redis::aio::MultiplexedConnection;
use redis::Value as R;
use std::sync::Arc;
use std::time::Instant;

/// Redis driver. The "query" language is raw Redis commands; keys appear as objects and
/// `@view <key>` shows a key's contents according to its type.
pub struct RedisDriver;

struct RedisConn(MultiplexedConnection);

fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[async_trait]
impl Driver for RedisDriver {
    fn kind(&self) -> &'static str {
        "redis"
    }
    async fn connect(&self, cfg: &ConnConfig) -> Result<Arc<dyn Connection>> {
        let scheme = if matches!(cfg.ssl.as_deref(), Some("require" | "verify")) { "rediss" } else { "redis" };
        let auth = match (cfg.user.as_deref().filter(|u| !u.is_empty()), cfg.password.as_deref().filter(|p| !p.is_empty())) {
            (Some(u), Some(p)) => format!("{}:{}@", enc(u), enc(p)),
            (None, Some(p)) => format!(":{}@", enc(p)),
            (Some(u), None) => format!("{}@", enc(u)),
            _ => String::new(),
        };
        let db: u32 = cfg.database.as_deref().and_then(|d| d.parse().ok()).unwrap_or(0);
        let insecure = if scheme == "rediss" && cfg.ssl.as_deref() == Some("require") { "#insecure" } else { "" };
        let url = format!("{scheme}://{auth}{}:{}/{db}{insecure}", cfg.host.as_deref().unwrap_or("127.0.0.1"), cfg.port.unwrap_or(6379));
        let client = redis::Client::open(url).map_err(DbError::msg)?;
        let conn = tokio::time::timeout(std::time::Duration::from_secs(10), client.get_multiplexed_async_connection())
            .await
            .map_err(|_| DbError::msg("connection timed out"))?
            .map_err(DbError::msg)?;
        Ok(Arc::new(RedisConn(conn)))
    }
}

/// Split a command line on whitespace, honouring "double" and 'single' quotes.
pub fn tokenize(line: &str) -> Vec<String> {
    let (mut out, mut cur, mut quote, mut has) = (Vec::new(), String::new(), None::<char>, false);
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') => match chars.next() {
                Some('n') => cur.push('\n'),
                Some('t') => cur.push('\t'),
                Some(o) => cur.push(o),
                None => {}
            },
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => { quote = Some(c); has = true; }
            (None, c) if c.is_whitespace() => {
                if has || !cur.is_empty() { out.push(std::mem::take(&mut cur)); has = false; }
            }
            (None, c) => cur.push(c),
        }
    }
    if has || !cur.is_empty() { out.push(cur); }
    out
}

fn text(v: &R) -> String {
    match v {
        R::Nil => "NULL".into(),
        R::Int(i) => i.to_string(),
        R::BulkString(b) => String::from_utf8_lossy(b).into_owned(),
        R::SimpleString(s) => s.clone(),
        R::Okay => "OK".into(),
        R::Double(d) => d.to_string(),
        R::Boolean(b) => b.to_string(),
        R::Array(a) | R::Set(a) => format!("[{}]", a.iter().map(text).collect::<Vec<_>>().join(", ")),
        R::Map(m) => format!("{{{}}}", m.iter().map(|(k, v)| format!("{}: {}", text(k), text(v))).collect::<Vec<_>>().join(", ")),
        other => format!("{other:?}"),
    }
}

fn val(v: &R) -> Value {
    match v {
        R::Nil => Value::Null,
        R::Int(i) => Value::I64(*i),
        R::Double(d) => Value::F64(*d),
        R::Boolean(b) => Value::Bool(*b),
        other => Value::Text(text(other)),
    }
}

fn col(name: &str) -> ColumnMeta {
    ColumnMeta { name: name.into(), type_name: String::new() }
}

/// Turn any reply into a grid: arrays become rows, maps become key/value pairs.
fn to_result(reply: &R) -> QueryResult {
    let mut r = QueryResult::default();
    match reply {
        R::Array(items) | R::Set(items) => {
            r.columns = vec![col("#"), col("value")];
            r.rows = items.iter().enumerate().map(|(i, v)| vec![Value::I64(i as i64 + 1), val(v)]).collect();
        }
        R::Map(pairs) => {
            r.columns = vec![col("key"), col("value")];
            r.rows = pairs.iter().map(|(k, v)| vec![val(k), val(v)]).collect();
        }
        other => {
            r.columns = vec![col("value")];
            r.rows = vec![vec![val(other)]];
        }
    }
    r
}

fn pairs(name_a: &str, name_b: &str, flat: &R) -> QueryResult {
    let items = match flat { R::Array(a) => a.as_slice(), _ => &[] };
    QueryResult {
        columns: vec![col(name_a), col(name_b)],
        rows: items.chunks(2).map(|c| vec![val(&c[0]), c.get(1).map(val).unwrap_or(Value::Null)]).collect(),
        ..Default::default()
    }
}

impl RedisConn {
    async fn run(&self, args: &[String]) -> Result<R> {
        let mut c = self.0.clone();
        let mut cmd = redis::cmd(&args[0]);
        for a in &args[1..] {
            cmd.arg(a.as_str());
        }
        cmd.query_async::<R>(&mut c).await.map_err(DbError::msg)
    }
    async fn cmd(&self, parts: &[&str]) -> Result<R> {
        self.run(&parts.iter().map(|s| s.to_string()).collect::<Vec<_>>()).await
    }
    async fn view(&self, key: &str) -> Result<QueryResult> {
        let ty = text(&self.cmd(&["TYPE", key]).await?);
        let mut r = match ty.as_str() {
            "string" => {
                let v = self.cmd(&["GET", key]).await?;
                QueryResult { columns: vec![col("key"), col("value")], rows: vec![vec![Value::Text(key.into()), val(&v)]], ..Default::default() }
            }
            "list" => {
                let v = self.cmd(&["LRANGE", key, "0", "999"]).await?;
                let mut q = to_result(&v);
                q.columns = vec![col("index"), col("value")];
                for (i, row) in q.rows.iter_mut().enumerate() { row[0] = Value::I64(i as i64); }
                q
            }
            "set" => {
                let v = self.cmd(&["SSCAN", key, "0", "COUNT", "1000"]).await?;
                let members = if let R::Array(a) = &v { a.get(1).cloned().unwrap_or(R::Nil) } else { R::Nil };
                let mut q = to_result(&members);
                q.columns = vec![col("#"), col("member")];
                q
            }
            "zset" => pairs("member", "score", &self.cmd(&["ZRANGE", key, "0", "999", "WITHSCORES"]).await?),
            "hash" => {
                let v = self.cmd(&["HSCAN", key, "0", "COUNT", "1000"]).await?;
                pairs("field", "value", &if let R::Array(a) = &v { a.get(1).cloned().unwrap_or(R::Nil) } else { R::Nil })
            }
            "none" => return Err(DbError::msg(format!("key '{key}' does not exist"))),
            other => QueryResult { columns: vec![col("key"), col("type")], rows: vec![vec![Value::Text(key.into()), Value::Text(other.into())]], ..Default::default() },
        };
        r.affected = None;
        Ok(r)
    }
}

#[async_trait]
impl Connection for RedisConn {
    fn dialect(&self) -> &'static str {
        "redis"
    }
    fn select_all(&self, _schema: Option<&str>, name: &str, _limit: usize) -> String {
        format!("@view \"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
    }
    async fn ping(&self) -> Result<()> {
        self.cmd(&["PING"]).await.map(|_| ())
    }
    async fn objects(&self) -> Result<Vec<ObjectRef>> {
        let (mut cursor, mut keys) = ("0".to_string(), Vec::<String>::new());
        loop {
            let reply = self.cmd(&["SCAN", &cursor, "COUNT", "1000"]).await?;
            let R::Array(parts) = reply else { break };
            cursor = parts.first().map(text).unwrap_or_else(|| "0".into());
            if let Some(R::Array(batch)) = parts.get(1) {
                keys.extend(batch.iter().map(text));
            }
            if cursor == "0" || keys.len() >= 5000 {
                break;
            }
        }
        keys.sort();
        keys.dedup();
        Ok(keys.into_iter().map(|k| ObjectRef { schema: None, name: k, kind: "key".into() }).collect())
    }
    async fn describe(&self, _schema: Option<&str>, name: &str) -> Result<ObjectInfo> {
        let ty = text(&self.cmd(&["TYPE", name]).await?);
        let ttl = text(&self.cmd(&["TTL", name]).await?);
        let ttl = if ttl == "-1" { "no expiry".to_string() } else { format!("{ttl} s") };
        Ok(ObjectInfo { columns: vec![], indexes: vec![], ddl: Some(format!("type: {ty}\nttl: {ttl}")), ..Default::default() })
    }
    async fn query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        let args = tokenize(sql.trim().trim_end_matches(';'));
        if args.is_empty() {
            return Err(DbError::msg("empty command"));
        }
        let mut r = if args[0].eq_ignore_ascii_case("@view") {
            self.view(args.get(1).ok_or_else(|| DbError::msg("usage: @view <key>"))?).await?
        } else {
            to_result(&self.run(&args).await?)
        };
        r.elapsed_ms = start.elapsed().as_millis();
        Ok(r)
    }
    async fn schema_map(&self) -> Result<Vec<SchemaTable>> {
        Ok(vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::tokenize;
    #[test]
    fn tokenizer() {
        assert_eq!(tokenize(r#"SET key "hello world" 'a b'"#), vec!["SET", "key", "hello world", "a b"]);
        assert_eq!(tokenize(r#"SET k "say \"hi\"""#), vec!["SET", "k", r#"say "hi""#]);
        assert_eq!(tokenize(r#"SET k """#), vec!["SET", "k", ""]);
        assert_eq!(tokenize("  GET   x  "), vec!["GET", "x"]);
    }
}
