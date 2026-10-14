use dbbackup::*;
use dbcore::*;
use driver_sqlite::SqliteDriver;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

const NO_CANCEL: AtomicBool = AtomicBool::new(false);

async fn db() -> Arc<dyn Connection> {
    SqliteDriver.connect(&ConnConfig { kind: "sqlite".into(), ..Default::default() }).await.unwrap()
}
fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("lattice-backup-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d.join(name)
}
fn bo() -> BackupOptions {
    BackupOptions { tables: None, structure: true, data: true, views: true, gzip: false, add_drop: false }
}

async fn seed(c: &Arc<dyn Connection>) {
    for q in [
        "CREATE TABLE country(id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
        "CREATE TABLE person(id INTEGER PRIMARY KEY, country_id INTEGER REFERENCES country(id), name TEXT, bio TEXT, score REAL, photo BLOB)",
        "CREATE INDEX person_name ON person(name)",
        "CREATE VIEW person_names AS SELECT name FROM person WHERE name IS NOT NULL",
        "CREATE TRIGGER person_ai AFTER INSERT ON person BEGIN SELECT 1; END",
        "INSERT INTO country VALUES (1, 'Norway'), (2, 'Peru')",
    ] {
        c.query(q).await.unwrap();
    }
    // Awkward values: quotes, semicolons, newlines, comment markers, unicode, NULLs, a blob.
    c.query(r#"INSERT INTO person VALUES
        (1, 1, 'Ada; ''the'' first', 'line one
line two -- not a comment /* nor this */', 1.5, X'00FF10'),
        (2, 2, NULL, '', NULL, NULL),
        (3, NULL, 'Zoë ☃', 'back\slash', 3.0, X'')"#).await.unwrap();
}

async fn rows(c: &Arc<dyn Connection>, sql: &str) -> Vec<Vec<Value>> {
    c.query(sql).await.unwrap().rows
}

#[tokio::test]
async fn sqlite_backup_restores_identically_plain_and_gzip() {
    let src = db().await;
    seed(&src).await;
    for gzip in [false, true] {
        let f = tmp(if gzip { "b.sql.gz" } else { "b.sql" });
        let rep = backup(src.as_ref(), &f, &BackupOptions { gzip, ..bo() }, &|_| {}, &NO_CANCEL).await.unwrap();
        assert_eq!((rep.tables, rep.rows), (2, 5), "gzip={gzip}");
        if gzip {
            assert_eq!(&std::fs::read(&f).unwrap()[..2], &[0x1f, 0x8b], "really gzip");
        } else {
            let text = std::fs::read_to_string(&f).unwrap();
            assert!(text.contains("CREATE TABLE") && text.contains("INSERT INTO \"person\""));
        }

        let dst = db().await;
        let r = restore(dst.as_ref(), &f, &RestoreOptions { stop_on_error: true }, &|_| {}, &NO_CANCEL).await.unwrap();
        assert_eq!(r.failed, 0, "{:?}", r.errors);

        for q in ["SELECT * FROM country ORDER BY id", "SELECT * FROM person ORDER BY id", "SELECT * FROM person_names ORDER BY name"] {
            assert_eq!(rows(&src, q).await, rows(&dst, q).await, "{q} (gzip={gzip})");
        }
        // Structure survived too: the index, the trigger, the foreign key.
        let d = dst.describe(None, "person").await.unwrap();
        assert!(d.index_details.iter().any(|i| i.name == "person_name"));
        assert_eq!(d.foreign_keys.len(), 1);
        let trig = rows(&dst, "SELECT name FROM sqlite_master WHERE type = 'trigger'").await;
        assert_eq!(trig.len(), 1);
    }
}

#[tokio::test]
async fn partial_backups_structure_only_and_data_only() {
    let src = db().await;
    seed(&src).await;
    // Only one table, structure only.
    let f = tmp("s.sql");
    let o = BackupOptions { tables: Some(vec![TableRef { schema: None, name: "country".into() }]), data: false, ..bo() };
    let rep = backup(src.as_ref(), &f, &o, &|_| {}, &NO_CANCEL).await.unwrap();
    assert_eq!((rep.tables, rep.rows), (1, 0));
    let dst = db().await;
    restore(dst.as_ref(), &f, &RestoreOptions { stop_on_error: true }, &|_| {}, &NO_CANCEL).await.unwrap();
    assert_eq!(rows(&dst, "SELECT COUNT(*) FROM country").await[0][0], Value::I64(0));
    assert!(dst.query("SELECT * FROM person").await.is_err(), "person was not backed up");

    // Data only into a database that already has the tables.
    let f2 = tmp("d.sql");
    backup(src.as_ref(), &f2, &BackupOptions { structure: false, ..bo() }, &|_| {}, &NO_CANCEL).await.unwrap();
    let text = std::fs::read_to_string(&f2).unwrap();
    assert!(!text.contains("CREATE TABLE") && text.contains("INSERT INTO"));
    restore(dst.as_ref(), &f2, &RestoreOptions { stop_on_error: false }, &|_| {}, &NO_CANCEL).await.ok();
    assert_eq!(rows(&dst, "SELECT COUNT(*) FROM country").await[0][0], Value::I64(2));
}

#[tokio::test]
async fn restore_error_handling_and_cancel() {
    let dst = db().await;
    let f = tmp("bad.sql");
    std::fs::write(&f, "CREATE TABLE t(a INTEGER);\nINSERT INTO t VALUES (1);\nINSERT INTO nope VALUES (1);\nINSERT INTO t VALUES (2);\n").unwrap();
    // Default: stop at the first failure and say where.
    let e = restore(dst.as_ref(), &f, &RestoreOptions { stop_on_error: true }, &|_| {}, &NO_CANCEL).await.unwrap_err().to_string();
    assert!(e.contains("statement 3 failed") && e.contains("INSERT INTO nope"), "{e}");
    assert_eq!(rows(&dst, "SELECT COUNT(*) FROM t").await[0][0], Value::I64(1));
    // Carry on: later statements still run and the failure is reported.
    let dst2 = db().await;
    let r = restore(dst2.as_ref(), &f, &RestoreOptions { stop_on_error: false }, &|_| {}, &NO_CANCEL).await.unwrap();
    assert_eq!((r.statements, r.failed, r.errors.len()), (4, 1, 1));
    assert_eq!(rows(&dst2, "SELECT COUNT(*) FROM t").await[0][0], Value::I64(2));
    // Cancel: a half-written backup file is removed.
    let src = db().await;
    seed(&src).await;
    let out = tmp("cancelled.sql");
    let stop = AtomicBool::new(true);
    assert!(backup(src.as_ref(), &out, &bo(), &|_| {}, &stop).await.is_err());
    assert!(!out.exists());
}

#[tokio::test]
async fn backup_of_a_large_table_streams_and_restores() {
    let src = db().await;
    src.query("CREATE TABLE big(id INTEGER PRIMARY KEY, a TEXT, b REAL)").await.unwrap();
    src.query("WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n < 100000) INSERT INTO big SELECT n, 'row-' || n, n * 0.5 FROM r").await.unwrap();
    let f = tmp("big.sql.gz");
    let t = std::time::Instant::now();
    let rep = backup(src.as_ref(), &f, &BackupOptions { gzip: true, ..bo() }, &|_| {}, &NO_CANCEL).await.unwrap();
    let backup_ms = t.elapsed().as_millis();
    assert_eq!(rep.rows, 100_000);
    let dst = db().await;
    let t = std::time::Instant::now();
    restore(dst.as_ref(), &f, &RestoreOptions { stop_on_error: true }, &|_| {}, &NO_CANCEL).await.unwrap();
    let restore_ms = t.elapsed().as_millis();
    println!("100k rows: backup {backup_ms} ms, restore {restore_ms} ms, file {} KB", rep.bytes / 1024);
    assert_eq!(rows(&dst, "SELECT COUNT(*), SUM(id) FROM big").await[0], vec![Value::I64(100_000), Value::I64(5_000_050_000)]);
}
