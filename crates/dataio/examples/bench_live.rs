//! Live benchmark against a server holding `people` (see LOG.md):
//!   cargo run --release -p dataio --example bench_live -- pg 55432     # or: mysql 53306
use dataio::*;
use dbcore::*;
use std::sync::atomic::AtomicBool;

#[tokio::main]
async fn main() {
    let mut a = std::env::args().skip(1);
    let kind = a.next().unwrap_or_else(|| "pg".into());
    let port: u16 = a.next().and_then(|p| p.parse().ok()).unwrap_or(55432);
    let c: std::sync::Arc<dyn Connection> = if kind == "pg" {
        let cfg = ConnConfig { kind: "postgres".into(), host: Some("127.0.0.1".into()), port: Some(port), user: Some("postgres".into()), password: Some("pw".into()), database: Some("app".into()), ssl: Some("disable".into()), ..Default::default() };
        driver_postgres::PostgresDriver.connect(&cfg).await.unwrap()
    } else {
        let cfg = ConnConfig { kind: "mysql".into(), host: Some("127.0.0.1".into()), port: Some(port), user: Some("root".into()), password: Some("pw".into()), database: Some("app".into()), ssl: Some("disable".into()), ..Default::default() };
        driver_mysql::MysqlDriver.connect(&cfg).await.unwrap()
    };
    let path = std::path::PathBuf::from(format!("bench/live-{kind}.csv"));
    std::fs::create_dir_all("bench").unwrap();
    let no = AtomicBool::new(false);
    let t = std::time::Instant::now();
    let rows = export(c.as_ref(), "SELECT * FROM people", &path, &ExportOptions { format: ExportFormat::Csv, header: true, delimiter: None, table: None, batch_rows: 5000 }, &|_| {}, &no).await.unwrap();
    let s = t.elapsed().as_secs_f64();
    println!("{kind}: export CSV  {rows} rows  {s:.2} s  {:.0} rows/s  {:.1} MB", rows as f64 / s, std::fs::metadata(&path).unwrap().len() as f64 / 1e6);

    let _ = c.query("DROP TABLE people_copy").await;
    let p = preview(&path, true, None).unwrap();
    let t = std::time::Instant::now();
    let rep = import(c.as_ref(), &path, &ImportOptions { schema: None, table: "people_copy".into(), create: true, has_header: true, delimiter: None, mapping: p.headers.iter().cloned().map(Some).collect(), empty_as_null: true }, &|_| {}, &no).await.unwrap();
    let s = t.elapsed().as_secs_f64();
    println!("{kind}: import CSV  {} rows  {s:.2} s  {:.0} rows/s", rep.rows, rep.rows as f64 / s);
}
