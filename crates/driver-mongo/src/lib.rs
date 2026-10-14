use async_trait::async_trait;
use dbcore::*;
use futures_util::TryStreamExt;
use mongodb::bson::{Bson, Document};
use mongodb::{Client, Database};
use std::sync::Arc;
use std::time::Instant;

/// MongoDB driver. Queries use shell-like syntax:
/// `db["users"].find({"age": {"$gt": 18}}).limit(50)`, `.count({...})`, `.aggregate([...])`.
pub struct MongoDriver;

struct MongoConn {
    db: Database,
}

fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[async_trait]
impl Driver for MongoDriver {
    fn kind(&self) -> &'static str {
        "mongo"
    }
    async fn connect(&self, cfg: &ConnConfig) -> Result<Arc<dyn Connection>> {
        let auth = match (cfg.user.as_deref().filter(|u| !u.is_empty()), cfg.password.as_deref().filter(|p| !p.is_empty())) {
            (Some(u), Some(p)) => format!("{}:{}@", enc(u), enc(p)),
            (Some(u), None) => format!("{}@", enc(u)),
            _ => String::new(),
        };
        let db = cfg.database.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| "test".into());
        let tls = match cfg.ssl.as_deref() {
            Some("require") => "&tls=true&tlsAllowInvalidCertificates=true",
            Some("verify") => "&tls=true",
            _ => "",
        };
        let uri = format!(
            "mongodb://{auth}{}:{}/?authSource=admin&serverSelectionTimeoutMS=8000{tls}",
            cfg.host.as_deref().unwrap_or("127.0.0.1"),
            cfg.port.unwrap_or(27017)
        );
        let client = Client::with_uri_str(uri).await.map_err(DbError::msg)?;
        Ok(Arc::new(MongoConn { db: client.database(&db) }))
    }
}

/// Parsed shell-style command.
#[derive(Debug, PartialEq)]
pub struct Cmd {
    pub collection: String,
    pub op: String,
    pub arg: String,
    pub limit: Option<i64>,
}

pub fn parse(input: &str) -> Result<Cmd> {
    let s = input.trim().trim_end_matches(';').trim();
    let usage = || DbError::msg("expected: db[\"collection\"].find({...}) | .count({...}) | .aggregate([...])  (optional .limit(n) after find)");
    let rest = s.strip_prefix("db").ok_or_else(usage)?;
    let (collection, rest) = if let Some(r) = rest.strip_prefix("[\"") {
        let end = r.find("\"]").ok_or_else(usage)?;
        (r[..end].to_string(), &r[end + 2..])
    } else if let Some(r) = rest.strip_prefix('.') {
        let end = r.find('.').ok_or_else(usage)?;
        (r[..end].to_string(), &r[end..])
    } else {
        return Err(usage());
    };
    let rest = rest.strip_prefix('.').ok_or_else(usage)?;
    let open = rest.find('(').ok_or_else(usage)?;
    let op = rest[..open].to_string();
    if !matches!(op.as_str(), "find" | "count" | "countDocuments" | "aggregate") {
        return Err(DbError::msg(format!("unsupported operation '{op}' (read-only: find, count, aggregate)")));
    }
    let (mut body, mut limit) = (rest[open + 1..].trim_end().to_string(), None);
    // Optional trailing .limit(n)
    if let Some(i) = body.rfind(").limit(") {
        let tail = &body[i + 8..];
        if let Some(n) = tail.strip_suffix(')').and_then(|n| n.trim().parse::<i64>().ok()) {
            limit = Some(n);
            body.truncate(i + 1);
        }
    }
    let arg = body.strip_suffix(')').ok_or_else(usage)?.trim().to_string();
    Ok(Cmd { collection, op, arg, limit })
}

fn bson_of(arg: &str, default: &str) -> Result<Bson> {
    let text = if arg.is_empty() { default } else { arg };
    // Bson's serde impl understands extended JSON ($oid, $date, ...).
    serde_json::from_str::<Bson>(text).map_err(|e| DbError::msg(format!("invalid JSON: {e}")))
}

fn value_of(b: &Bson) -> Value {
    match b {
        Bson::Null => Value::Null,
        Bson::String(s) => Value::Text(s.clone()),
        Bson::Int32(i) => Value::I64(*i as i64),
        Bson::Int64(i) => Value::I64(*i),
        Bson::Double(d) => Value::F64(*d),
        Bson::Boolean(b) => Value::Bool(*b),
        Bson::ObjectId(o) => Value::Text(o.to_hex()),
        Bson::DateTime(d) => Value::Text(d.try_to_rfc3339_string().unwrap_or_else(|_| d.to_string())),
        other => Value::Text(serde_json::to_string(other).unwrap_or_else(|_| other.to_string())),
    }
}

fn type_of(b: &Bson) -> &'static str {
    match b {
        Bson::Null => "null",
        Bson::String(_) => "string",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Double(_) => "double",
        Bson::Boolean(_) => "bool",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Document(_) => "object",
        Bson::Array(_) => "array",
        _ => "other",
    }
}

fn docs_to_result(docs: Vec<Document>) -> QueryResult {
    let mut names: Vec<String> = Vec::new();
    for d in docs.iter().take(1000) {
        for k in d.keys() {
            if !names.contains(k) {
                names.push(k.clone());
            }
        }
    }
    if let Some(i) = names.iter().position(|n| n == "_id") {
        names.swap(0, i);
    }
    let columns = names.iter().map(|n| ColumnMeta { name: n.clone(), type_name: docs.iter().find_map(|d| d.get(n)).map(|b| type_of(b).to_string()).unwrap_or_default() }).collect();
    let rows = docs.iter().map(|d| names.iter().map(|n| d.get(n).map(value_of).unwrap_or(Value::Null)).collect()).collect();
    QueryResult { columns, rows, ..Default::default() }
}

#[async_trait]
impl Connection for MongoConn {
    fn dialect(&self) -> &'static str {
        "mongo"
    }
    fn select_all(&self, _schema: Option<&str>, name: &str, limit: usize) -> String {
        format!("db[\"{name}\"].find({{}}).limit({limit})")
    }
    async fn ping(&self) -> Result<()> {
        self.db.run_command(mongodb::bson::doc! { "ping": 1 }).await.map(|_| ()).map_err(DbError::msg)
    }
    async fn objects(&self) -> Result<Vec<ObjectRef>> {
        let mut names = self.db.list_collection_names().await.map_err(DbError::msg)?;
        names.sort();
        Ok(names.into_iter().map(|n| ObjectRef { schema: None, name: n, kind: "collection".into() }).collect())
    }
    async fn describe(&self, _schema: Option<&str>, name: &str) -> Result<ObjectInfo> {
        // Fields are inferred from a sample; none is a primary key so the grid stays read-only.
        let docs: Vec<Document> = self.db.collection::<Document>(name).find(Document::new()).limit(100).await.map_err(DbError::msg)?.try_collect().await.map_err(DbError::msg)?;
        let r = docs_to_result(docs);
        let columns = r.columns.into_iter().map(|c| ColumnInfo { name: c.name, type_name: c.type_name, nullable: true, primary_key: false, default: None }).collect();
        Ok(ObjectInfo { columns, indexes: vec![], ddl: None })
    }
    async fn query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        let cmd = parse(sql)?;
        let coll = self.db.collection::<Document>(&cmd.collection);
        let mut r = match cmd.op.as_str() {
            "find" => {
                let Bson::Document(filter) = bson_of(&cmd.arg, "{}")? else { return Err(DbError::msg("find expects a JSON object filter")) };
                let mut f = coll.find(filter);
                if let Some(n) = cmd.limit {
                    f = f.limit(n);
                }
                docs_to_result(f.await.map_err(DbError::msg)?.try_collect().await.map_err(DbError::msg)?)
            }
            "count" | "countDocuments" => {
                let Bson::Document(filter) = bson_of(&cmd.arg, "{}")? else { return Err(DbError::msg("count expects a JSON object filter")) };
                let n = coll.count_documents(filter).await.map_err(DbError::msg)?;
                QueryResult { columns: vec![ColumnMeta { name: "count".into(), type_name: "long".into() }], rows: vec![vec![Value::I64(n as i64)]], ..Default::default() }
            }
            _ => {
                let Bson::Array(stages) = bson_of(&cmd.arg, "[]")? else { return Err(DbError::msg("aggregate expects a JSON array pipeline")) };
                let pipeline: Vec<Document> = stages.into_iter().map(|s| if let Bson::Document(d) = s { Ok(d) } else { Err(DbError::msg("pipeline stages must be objects")) }).collect::<Result<_>>()?;
                docs_to_result(coll.aggregate(pipeline).await.map_err(DbError::msg)?.try_collect().await.map_err(DbError::msg)?)
            }
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
    use super::*;
    #[test]
    fn parses_shell_syntax() {
        let c = parse(r#"db["users"].find({"age": {"$gt": 18}}).limit(5);"#).unwrap();
        assert_eq!((c.collection.as_str(), c.op.as_str(), c.arg.as_str(), c.limit), ("users", "find", r#"{"age": {"$gt": 18}}"#, Some(5)));
        let c = parse("db.orders.count()").unwrap();
        assert_eq!((c.collection.as_str(), c.op.as_str(), c.arg.as_str()), ("orders", "count", ""));
        let c = parse(r#"db.t.aggregate([{"$match": {"a": 1}}])"#).unwrap();
        assert_eq!(c.op, "aggregate");
        assert!(parse("db.t.drop()").is_err());
        assert!(parse("SELECT 1").is_err());
    }
}
