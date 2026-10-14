//! Release-mode benchmark on a SQLite file: cargo run --release -p dataio --example bench -- bench/bench.db 1000000
//! Leaves the database (and the exported CSV) on disk so other tools can be timed on the same data.
use dataio::*;
use dbcore::*;
use std::sync::atomic::AtomicBool;

#[tokio::main]
async fn main() {
    let mut a = std::env::args().skip(1);
    let db = a.next().unwrap_or_else(|| "bench/bench.db".into());
    let n: u64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(1_000_000);
    let _ = std::fs::remove_file(&db);
    let c = driver_sqlite::SqliteDriver.connect(&ConnConfig { kind: "sqlite".into(), path: Some(db.clone()), ..Default::default() }).await.unwrap();
    c.query("CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT, email TEXT, age INTEGER, balance REAL, created TEXT, note TEXT)").await.unwrap();
    c.query(&format!("WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n < {n}) INSERT INTO people SELECT n, 'Person ' || n, 'user' || n || '@example.com', 18 + n % 60, n * 1.37, '2024-01-' || (1 + n % 28), CASE WHEN n % 5 = 0 THEN NULL ELSE 'note, with \"quotes\" #' || n END FROM r")).await.unwrap();
    let csv = format!("{}.csv", db.trim_end_matches(".db"));
    let no = AtomicBool::new(false);
    for (label, fmt, path) in [("CSV", ExportFormat::Csv, csv.clone()), ("JSON", ExportFormat::Json, csv.replace(".csv", ".json")), ("SQL", ExportFormat::Sql, csv.replace(".csv", ".sql"))] {
        let t = std::time::Instant::now();
        let rows = export(c.as_ref(), "SELECT * FROM people", std::path::Path::new(&path), &ExportOptions { format: fmt, header: true, delimiter: None, table: Some("people".into()), batch_rows: 5000 }, &|_| {}, &no).await.unwrap();
        let s = t.elapsed().as_secs_f64();
        println!("export {label:<4} {rows} rows  {s:.2} s  {:.0} rows/s  {:.1} MB", rows as f64 / s, std::fs::metadata(&path).unwrap().len() as f64 / 1e6);
    }
    let p = preview(std::path::Path::new(&csv), true, None).unwrap();
    let t = std::time::Instant::now();
    let rep = import(c.as_ref(), std::path::Path::new(&csv), &ImportOptions { schema: None, table: "people_copy".into(), create: true, has_header: true, delimiter: None, mapping: p.headers.iter().cloned().map(Some).collect(), empty_as_null: true }, &|_| {}, &no).await.unwrap();
    let s = t.elapsed().as_secs_f64();
    println!("import CSV  {} rows  {s:.2} s  {:.0} rows/s  (new table, inferred types)", rep.rows, rep.rows as f64 / s);
    println!("files left in {}: {db}, {csv}", std::env::current_dir().unwrap().display());
}
