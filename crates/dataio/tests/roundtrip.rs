use dataio::*;
use dbcore::*;
use driver_sqlite::SqliteDriver;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

async fn db() -> Arc<dyn Connection> {
    SqliteDriver.connect(&ConnConfig { kind: "sqlite".into(), ..Default::default() }).await.unwrap()
}
fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("lattice-dataio-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d.join(name)
}
fn eo(format: ExportFormat) -> ExportOptions {
    ExportOptions { format, header: true, delimiter: None, table: Some("t".into()), batch_rows: 2 }
}
const NO_CANCEL: AtomicBool = AtomicBool::new(false);

async fn seed(c: &Arc<dyn Connection>) {
    c.query("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, score REAL, note TEXT)").await.unwrap();
    c.query(r#"INSERT INTO t VALUES (1,'Ada, "the" first',1.5,NULL),(2,'multi
line',NULL,'x'),(3,'  padded ',3,''),(4,'plain',4.25,'ü☃')"#).await.unwrap();
}

#[tokio::test]
async fn csv_export_then_import_roundtrips_into_new_table() {
    let c = db().await;
    seed(&c).await;
    let f = tmp("a.csv");
    let n = export(c.as_ref(), "SELECT * FROM t ORDER BY id", &f, &eo(ExportFormat::Csv), &|_| {}, &NO_CANCEL).await.unwrap();
    assert_eq!(n, 4);
    let text = std::fs::read_to_string(&f).unwrap();
    assert!(text.starts_with("id,name,score,note\n"));
    assert!(text.contains("\"Ada, \"\"the\"\" first\""));

    let p = preview(&f, true, None).unwrap();
    assert_eq!(p.headers, ["id", "name", "score", "note"]);
    assert_eq!(p.types, [ColType::Integer, ColType::Text, ColType::Real, ColType::Text]);

    let opts = ImportOptions { schema: None, table: "t2".into(), create: true, has_header: true, delimiter: None, mapping: p.headers.iter().cloned().map(Some).collect(), empty_as_null: true };
    let rep = import(c.as_ref(), &f, &opts, &|_| {}, &NO_CANCEL).await.unwrap();
    assert_eq!(rep.rows, 4);
    let a = c.query("SELECT id, name, score, note FROM t ORDER BY id").await.unwrap();
    let b = c.query("SELECT id, name, score, note FROM t2 ORDER BY id").await.unwrap();
    // Empty string and NULL both come back as NULL (empty_as_null); everything else is identical.
    assert_eq!(a.rows[0], b.rows[0]);
    assert_eq!(a.rows[1], b.rows[1]);
    assert_eq!(b.rows[2][3], Value::Null);
    assert_eq!(a.rows[3], b.rows[3]);
    assert_eq!(b.rows[2][1], Value::Text("  padded ".into()));
    // Inferred column types made it into the DDL.
    let d = c.describe(None, "t2").await.unwrap();
    assert_eq!(d.columns.iter().map(|c| c.type_name.as_str()).collect::<Vec<_>>(), ["INTEGER", "TEXT", "REAL", "TEXT"]);
}

#[tokio::test]
async fn json_jsonl_and_sql_exports() {
    let c = db().await;
    seed(&c).await;
    let j = tmp("a.json");
    export(c.as_ref(), "SELECT id, name, score FROM t ORDER BY id", &j, &eo(ExportFormat::Json), &|_| {}, &NO_CANCEL).await.unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&j).unwrap()).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 4);
    assert_eq!(v[0]["name"], "Ada, \"the\" first");
    assert!(v[1]["score"].is_null());

    let l = tmp("a.jsonl");
    export(c.as_ref(), "SELECT id FROM t ORDER BY id", &l, &eo(ExportFormat::Jsonl), &|_| {}, &NO_CANCEL).await.unwrap();
    assert_eq!(std::fs::read_to_string(&l).unwrap().lines().count(), 4);

    // The SQL export must be executable as-is.
    let s = tmp("a.sql");
    export(c.as_ref(), "SELECT * FROM t ORDER BY id", &s, &eo(ExportFormat::Sql), &|_| {}, &NO_CANCEL).await.unwrap();
    let c2 = db().await;
    c2.query("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, score REAL, note TEXT)").await.unwrap();
    for stmt in std::fs::read_to_string(&s).unwrap().split(";\n").filter(|s| !s.trim().is_empty()) {
        c2.query(stmt).await.unwrap();
    }
    let a = c.query("SELECT * FROM t ORDER BY id").await.unwrap();
    let b = c2.query("SELECT * FROM t ORDER BY id").await.unwrap();
    assert_eq!(a.rows, b.rows);

    // JSON import works too (objects → rows).
    let opts = ImportOptions { schema: None, table: "fromjson".into(), create: true, has_header: true, delimiter: None, mapping: vec![Some("id".into()), Some("name".into()), Some("score".into())], empty_as_null: true };
    import(c.as_ref(), &j, &opts, &|_| {}, &NO_CANCEL).await.unwrap();
    assert_eq!(c.query("SELECT COUNT(*) FROM fromjson").await.unwrap().rows[0][0], Value::I64(4));
}

#[tokio::test]
async fn export_empty_result_still_has_header() {
    let c = db().await;
    seed(&c).await;
    let f = tmp("empty.csv");
    assert_eq!(export(c.as_ref(), "SELECT id, name FROM t WHERE 1=0", &f, &eo(ExportFormat::Csv), &|_| {}, &NO_CANCEL).await.unwrap(), 0);
    assert_eq!(std::fs::read_to_string(&f).unwrap(), "id,name\n");
    let j = tmp("empty.json");
    export(c.as_ref(), "SELECT id FROM t WHERE 1=0", &j, &eo(ExportFormat::Json), &|_| {}, &NO_CANCEL).await.unwrap();
    assert!(serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(&j).unwrap()).unwrap().as_array().unwrap().is_empty());
}

#[tokio::test]
async fn mapping_skips_columns_and_delimiters_are_sniffed() {
    let c = db().await;
    c.query("CREATE TABLE people(name TEXT, age INTEGER)").await.unwrap();
    let f = tmp("semi.txt");
    std::fs::write(&f, "n;skip;a\nAda;x;36\nLinus;y;54\n").unwrap();
    let p = preview(&f, true, None).unwrap();
    assert_eq!(p.delimiter, ';');
    let opts = ImportOptions { schema: None, table: "people".into(), create: false, has_header: true, delimiter: None, mapping: vec![Some("name".into()), None, Some("age".into())], empty_as_null: true };
    assert_eq!(import(c.as_ref(), &f, &opts, &|_| {}, &NO_CANCEL).await.unwrap().rows, 2);
    let r = c.query("SELECT name, age FROM people ORDER BY age").await.unwrap();
    assert_eq!(r.rows[1], vec![Value::Text("Linus".into()), Value::I64(54)]);
}

#[tokio::test]
async fn leading_zeros_stay_text_and_headerless_files_work() {
    let c = db().await;
    let f = tmp("zip.csv");
    std::fs::write(&f, "02134,1\n10001,2\n").unwrap();
    let p = preview(&f, false, None).unwrap();
    assert_eq!(p.headers, ["column1", "column2"]);
    assert_eq!(p.types, [ColType::Text, ColType::Integer]);
    let opts = ImportOptions { schema: None, table: "z".into(), create: true, has_header: false, delimiter: None, mapping: vec![Some("zip".into()), Some("n".into())], empty_as_null: true };
    import(c.as_ref(), &f, &opts, &|_| {}, &NO_CANCEL).await.unwrap();
    assert_eq!(c.query("SELECT zip FROM z ORDER BY n").await.unwrap().rows[0][0], Value::Text("02134".into()));
}

#[tokio::test]
async fn failure_reports_committed_rows_and_cancel_removes_export() {
    let c = db().await;
    c.query("CREATE TABLE u(id INTEGER PRIMARY KEY)").await.unwrap();
    let f = tmp("dup.csv");
    std::fs::write(&f, "id\n1\n1\n").unwrap();
    let opts = ImportOptions { schema: None, table: "u".into(), create: false, has_header: true, delimiter: None, mapping: vec![Some("id".into())], empty_as_null: true };
    let err = import(c.as_ref(), &f, &opts, &|_| {}, &NO_CANCEL).await.unwrap_err().to_string();
    assert!(err.contains("0 rows were already committed"), "{err}");
    assert_eq!(c.query("SELECT COUNT(*) FROM u").await.unwrap().rows[0][0], Value::I64(0));

    seed(&c).await;
    let out = tmp("cancelled.csv");
    let stop = AtomicBool::new(true);
    assert!(export(c.as_ref(), "SELECT * FROM t", &out, &eo(ExportFormat::Csv), &|_| {}, &stop).await.is_err());
    assert!(!out.exists(), "partial export should be removed");
}

#[tokio::test]
async fn large_roundtrip_is_fast() {
    let c = db().await;
    c.query("CREATE TABLE big(id INTEGER PRIMARY KEY, a TEXT, b REAL)").await.unwrap();
    c.query("WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n < 100000) INSERT INTO big SELECT n, 'row-' || n, n * 0.5 FROM r").await.unwrap();
    let f = tmp("big.csv");
    let t = std::time::Instant::now();
    let opts = ExportOptions { batch_rows: 5000, ..eo(ExportFormat::Csv) };
    assert_eq!(export(c.as_ref(), "SELECT * FROM big", &f, &opts, &|_| {}, &NO_CANCEL).await.unwrap(), 100_000);
    let export_ms = t.elapsed().as_millis();
    let t = std::time::Instant::now();
    let iopts = ImportOptions { schema: None, table: "big2".into(), create: true, has_header: true, delimiter: None, mapping: vec![Some("id".into()), Some("a".into()), Some("b".into())], empty_as_null: true };
    assert_eq!(import(c.as_ref(), &f, &iopts, &|_| {}, &NO_CANCEL).await.unwrap().rows, 100_000);
    let import_ms = t.elapsed().as_millis();
    println!("100k rows: export {export_ms} ms, import {import_ms} ms");
    assert_eq!(c.query("SELECT SUM(id) FROM big2").await.unwrap().rows[0][0], Value::I64(5_000_050_000));
    assert!(export_ms < 5000 && import_ms < 10000, "too slow: export {export_ms} ms, import {import_ms} ms");
}
