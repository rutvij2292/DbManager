//! Needs servers: LATTICE_PG_PORT=55432 LATTICE_MYSQL_PORT=53306 cargo test -p dataio --test live -- --ignored --nocapture
use dataio::*;
use dbcore::*;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

const NO_CANCEL: AtomicBool = AtomicBool::new(false);

fn port(var: &str) -> u16 {
    std::env::var(var).unwrap_or_else(|_| panic!("{var} not set")).parse().unwrap()
}

async fn roundtrip(c: Arc<dyn Connection>, setup: &[&str], gen_sql: &str, label: &str) {
    for s in setup {
        c.query(s).await.unwrap();
    }
    let dir = std::env::temp_dir().join(format!("lattice-live-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join(format!("{label}.csv"));
    c.query(gen_sql).await.unwrap();

    let opts = ExportOptions { format: ExportFormat::Csv, header: true, delimiter: None, table: None, batch_rows: 5000 };
    let t = std::time::Instant::now();
    let n = export(c.as_ref(), "SELECT * FROM lat_src ORDER BY id", &f, &opts, &|_| {}, &NO_CANCEL).await.unwrap();
    let export_ms = t.elapsed().as_millis();
    assert_eq!(n, 50_000, "{label}: exported row count");

    let p = preview(&f, true, None).unwrap();
    assert_eq!(p.headers, ["id", "name", "score", "note"]);
    let t = std::time::Instant::now();
    let io = ImportOptions { schema: None, table: "lat_dst".into(), create: true, has_header: true, delimiter: None, mapping: p.headers.iter().cloned().map(Some).collect(), empty_as_null: true };
    let rep = import(c.as_ref(), &f, &io, &|_| {}, &NO_CANCEL).await.unwrap();
    let import_ms = t.elapsed().as_millis();
    assert_eq!(rep.rows, 50_000);
    println!("{label}: 50k rows export {export_ms} ms, import {import_ms} ms");

    let a = c.query("SELECT COUNT(*), SUM(id) FROM lat_src").await.unwrap().rows;
    let b = c.query("SELECT COUNT(*), SUM(id) FROM lat_dst").await.unwrap().rows;
    assert_eq!(a[0][0].display(), b[0][0].display());
    assert_eq!(a[0][1].display(), b[0][1].display());
    // Spot-check a tricky row survived quoting/NULL handling.
    let r = c.query("SELECT name, note FROM lat_dst WHERE id = 7").await.unwrap().rows;
    assert_eq!(r[0][0], Value::Text("quote \" comma , newline \n end".into()));
    assert_eq!(r[0][1], Value::Text("n".into())); // odd ids carry a note
    assert_eq!(c.query("SELECT note FROM lat_dst WHERE id = 8").await.unwrap().rows[0][0], Value::Null); // even ids are NULL
    // Early stop on cancel removes the partial file.
    let stop = AtomicBool::new(true);
    let out = dir.join(format!("{label}-cancel.csv"));
    assert!(export(c.as_ref(), "SELECT * FROM lat_src", &out, &opts, &|_| {}, &stop).await.is_err());
    assert!(!out.exists());
    // The shared connection is still healthy (cursor/stream did not leak a transaction).
    assert_eq!(c.query("SELECT 1").await.unwrap().rows.len(), 1);
}

#[tokio::test]
#[ignore]
async fn postgres_roundtrip() {
    let cfg = ConnConfig { kind: "postgres".into(), host: Some("127.0.0.1".into()), port: Some(port("LATTICE_PG_PORT")), user: Some("postgres".into()), password: Some("pw".into()), database: Some("app".into()), ..Default::default() };
    let c = driver_postgres::PostgresDriver.connect(&cfg).await.unwrap();
    roundtrip(
        c,
        &["DROP TABLE IF EXISTS lat_src", "DROP TABLE IF EXISTS lat_dst", "CREATE TABLE lat_src(id int PRIMARY KEY, name text, score float8, note text)"],
        "INSERT INTO lat_src SELECT g, CASE WHEN g = 7 THEN E'quote \" comma , newline \\n end' ELSE 'row ' || g END, g * 0.5, CASE WHEN g % 2 = 0 THEN NULL ELSE 'n' END FROM generate_series(1, 50000) g",
        "pg",
    )
    .await;
}

#[tokio::test]
#[ignore]
async fn mysql_roundtrip() {
    let cfg = ConnConfig { kind: "mysql".into(), host: Some("127.0.0.1".into()), port: Some(port("LATTICE_MYSQL_PORT")), user: Some("root".into()), password: Some("pw".into()), database: Some("app".into()), ssl: Some("disable".into()), ..Default::default() };
    let c = driver_mysql::MysqlDriver.connect(&cfg).await.unwrap();
    roundtrip(
        c,
        &["DROP TABLE IF EXISTS lat_src", "DROP TABLE IF EXISTS lat_dst", "CREATE TABLE lat_src(id int PRIMARY KEY, name text, score double, note text)", "SET GLOBAL cte_max_recursion_depth = 100000"],
        "INSERT INTO lat_src WITH RECURSIVE s(g) AS (SELECT 1 UNION ALL SELECT g + 1 FROM s WHERE g < 50000) SELECT g, IF(g = 7, CONCAT('quote \" comma , newline ', CHAR(10), ' end'), CONCAT('row ', g)), g * 0.5, IF(g % 2 = 0, NULL, 'n') FROM s",
        "mysql",
    )
    .await;
}
