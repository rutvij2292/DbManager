//! Peak-RSS check for .xlsx export: `/usr/bin/time -l cargo run --release -p dataio --example xlsx_mem -- 2000000 out.xlsx`
use dataio::*;
use dbcore::*;
use driver_sqlite::SqliteDriver;
use std::sync::atomic::AtomicBool;

#[tokio::main]
async fn main() {
    let mut a = std::env::args().skip(1);
    let n: u64 = a.next().unwrap().parse().unwrap();
    let out = std::path::PathBuf::from(a.next().unwrap());
    let c = SqliteDriver.connect(&ConnConfig { kind: "sqlite".into(), ..Default::default() }).await.unwrap();
    let sql = format!("WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i<{n}) SELECT i AS id, 'name ' || i AS name, i*1.5 AS score, NULL AS note FROM s");
    let t = std::time::Instant::now();
    let rows = export(c.as_ref(), &sql, &out, &ExportOptions { format: ExportFormat::Xlsx, header: true, delimiter: None, table: None, batch_rows: 5000 }, &|_| {}, &AtomicBool::new(false)).await.unwrap();
    println!("{rows} rows in {:.1}s, {:.1} MB", t.elapsed().as_secs_f64(), std::fs::metadata(&out).unwrap().len() as f64 / 1e6);
}
