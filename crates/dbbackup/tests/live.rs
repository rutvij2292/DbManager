//! Needs servers (see LOG.md):
//!   LATTICE_MYSQL_PORT=53307 cargo test -p dbbackup --test live -- --ignored --nocapture mysql
//!   LATTICE_PG_PORT=55432    cargo test -p dbbackup --test live -- --ignored --nocapture postgres
use dbbackup::*;
use dbcore::*;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

const NO_CANCEL: AtomicBool = AtomicBool::new(false);

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("lattice-backup-live-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d.join(name)
}
fn env_port(var: &str) -> u16 {
    std::env::var(var).unwrap_or_else(|_| panic!("{var} not set")).parse().unwrap()
}
async fn rows(c: &Arc<dyn Connection>, sql: &str) -> Vec<Vec<Value>> {
    c.query(sql).await.unwrap().rows
}

async fn mysql(db: &str) -> Arc<dyn Connection> {
    let cfg = ConnConfig { kind: "mysql".into(), host: Some("127.0.0.1".into()), port: Some(env_port("LATTICE_MYSQL_PORT")), user: Some("root".into()), password: Some("pw".into()), database: Some(db.into()), ssl: Some("disable".into()), ..Default::default() };
    driver_mysql::MysqlDriver.connect(&cfg).await.unwrap()
}

#[tokio::test]
#[ignore]
async fn mysql_backup_restores_into_another_database() {
    let src = mysql("src").await;
    for q in [
        "DROP VIEW IF EXISTS order_totals", "DROP TABLE IF EXISTS items", "DROP TABLE IF EXISTS orders",
        "CREATE TABLE orders(id INT AUTO_INCREMENT PRIMARY KEY, status ENUM('new','paid','void') NOT NULL DEFAULT 'new', total DECIMAL(10,2), note TEXT, placed DATETIME, photo BLOB, KEY idx_status (status)) ENGINE=InnoDB",
        "CREATE TABLE items(id INT AUTO_INCREMENT PRIMARY KEY, order_id INT NOT NULL, sku VARCHAR(40), CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE) ENGINE=InnoDB",
        r#"INSERT INTO orders (status, total, note, placed, photo) VALUES
            ('paid', 19.99, 'it''s a "test"; with \ backslash
and a second line -- not a comment', '2026-03-04 05:06:07', X'00FF10'),
            ('new', NULL, NULL, NULL, NULL),
            ('void', 0.00, '', '2000-01-01 00:00:00', X'')"#,
        "INSERT INTO items (order_id, sku) VALUES (1, 'A-1'), (1, 'B;2'), (3, 'C')",
        "CREATE VIEW order_totals AS SELECT status, COUNT(*) AS n FROM orders GROUP BY status",
    ] {
        src.query(q).await.unwrap();
    }

    for gzip in [false, true] {
        let f = tmp(if gzip { "m.sql.gz" } else { "m.sql" });
        let o = BackupOptions { tables: None, structure: true, data: true, views: true, gzip, add_drop: true };
        let rep = backup(src.as_ref(), &f, &o, &|_| {}, &NO_CANCEL).await.unwrap();
        assert_eq!((rep.tables, rep.rows), (2, 6), "gzip={gzip}");

        let dst = mysql("dst").await;
        for q in ["DROP VIEW IF EXISTS order_totals", "DROP TABLE IF EXISTS items", "DROP TABLE IF EXISTS orders"] {
            dst.query(q).await.unwrap();
        }
        let r = restore(dst.as_ref(), &f, &RestoreOptions { stop_on_error: true }, &|_| {}, &NO_CANCEL).await.unwrap();
        assert_eq!(r.failed, 0, "{:?}", r.errors);
        for q in ["SELECT * FROM orders ORDER BY id", "SELECT * FROM items ORDER BY id", "SELECT * FROM order_totals ORDER BY status"] {
            assert_eq!(rows(&src, q).await, rows(&dst, q).await, "{q} gzip={gzip}");
        }
        // Structure came through: the foreign key (with cascade), the index, and AUTO_INCREMENT continuing.
        let d = dst.describe(None, "items").await.unwrap();
        assert_eq!(d.foreign_keys.len(), 1);
        assert!(dst.describe(None, "orders").await.unwrap().index_details.iter().any(|i| i.name == "idx_status"));
        dst.query("INSERT INTO orders (status) VALUES ('new')").await.unwrap();
        assert_eq!(rows(&dst, "SELECT MAX(id) FROM orders").await[0][0], Value::I64(4), "auto_increment resumed after the data");
        dst.query("DELETE FROM orders WHERE id = 1").await.unwrap();
        assert_eq!(rows(&dst, "SELECT COUNT(*) FROM items").await[0][0], Value::I64(1), "ON DELETE CASCADE preserved");
    }
}

#[tokio::test]
#[ignore]
async fn mysql_restores_a_script_with_delimiter_blocks() {
    let dst = mysql("dst").await;
    let f = tmp("proc.sql");
    std::fs::write(&f, "DROP PROCEDURE IF EXISTS p_hello;\nDELIMITER //\nCREATE PROCEDURE p_hello()\nBEGIN\n  SELECT 'hi;there' AS msg;\n  SELECT 2;\nEND//\nDELIMITER ;\nCALL p_hello();\n").unwrap();
    let r = restore(dst.as_ref(), &f, &RestoreOptions { stop_on_error: true }, &|_| {}, &NO_CANCEL).await;
    // CALL returns result sets; the point is the procedure body was sent as one statement.
    assert!(r.is_ok(), "{:?}", r.err());
    assert_eq!(rows(&dst, "SELECT routine_name FROM information_schema.routines WHERE routine_schema = 'dst' AND routine_name = 'p_hello'").await.len(), 1);
}

async fn postgres(db: &str) -> Arc<dyn Connection> {
    let cfg = ConnConfig { kind: "postgres".into(), host: Some("127.0.0.1".into()), port: Some(env_port("LATTICE_PG_PORT")), user: Some("postgres".into()), password: Some("pw".into()), database: Some(db.into()), ssl: Some("disable".into()), ..Default::default() };
    driver_postgres::PostgresDriver.connect(&cfg).await.unwrap()
}

#[tokio::test]
#[ignore]
async fn postgres_backup_restores_into_another_database() {
    let src = postgres("src").await;
    for q in [
        "DROP VIEW IF EXISTS public.order_totals", "DROP TABLE IF EXISTS shop.items", "DROP TABLE IF EXISTS public.orders", "DROP SCHEMA IF EXISTS shop CASCADE", "DROP TYPE IF EXISTS public.status",
        "CREATE SCHEMA shop",
        "CREATE TYPE public.status AS ENUM ('new', 'paid', 'void')",
        "CREATE TABLE public.orders(id serial PRIMARY KEY, status public.status NOT NULL DEFAULT 'new', total numeric(10,2), note text, placed timestamptz, photo bytea, tags text[], \
            total_cents bigint GENERATED ALWAYS AS ((total * 100)::bigint) STORED, UNIQUE (placed, note), CHECK (total >= 0))",
        "CREATE INDEX idx_status ON public.orders (status) WHERE status <> 'void'",
        "CREATE TABLE shop.items(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, order_id int NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE, sku varchar(40))",
        r#"INSERT INTO public.orders (status, total, note, placed, photo, tags) VALUES
            ('paid', 19.99, 'it''s a "test"; with \ backslash	and a tab
and a second line -- not a comment', '2026-03-04 05:06:07+00', '\x00ff10', ARRAY['a','b,c']),
            ('new', NULL, NULL, NULL, NULL, NULL),
            ('void', 0.00, '', '2000-01-01 00:00:00+00', '\x', '{}')"#,
        "INSERT INTO shop.items (order_id, sku) VALUES (1, 'A-1'), (1, 'B;2'), (3, 'C')",
        "CREATE VIEW public.order_totals AS SELECT status, count(*) AS n FROM public.orders GROUP BY status",
    ] {
        src.query(q).await.unwrap_or_else(|e| panic!("{q}: {e}"));
    }

    for gzip in [false, true] {
        let f = tmp(if gzip { "p.sql.gz" } else { "p.sql" });
        let o = BackupOptions { tables: None, structure: true, data: true, views: true, gzip, add_drop: false };
        let rep = backup(src.as_ref(), &f, &o, &|_| {}, &NO_CANCEL).await.unwrap();
        assert_eq!((rep.tables, rep.rows), (2, 6), "gzip={gzip}");
        if !gzip {
            let text = std::fs::read_to_string(&f).unwrap();
            assert!(text.contains("COPY ") && text.contains("FROM stdin;"), "data should use COPY");
            assert!(text.contains("CREATE TYPE \"public\".\"status\"") && text.contains("CREATE SCHEMA IF NOT EXISTS \"shop\""));
            assert!(!text.contains("total_cents\" bigint GENERATED ALWAYS AS") || text.contains("STORED"));
        }

        let dst = postgres("dst").await;
        for q in ["DROP VIEW IF EXISTS public.order_totals", "DROP TABLE IF EXISTS shop.items", "DROP TABLE IF EXISTS public.orders", "DROP SCHEMA IF EXISTS shop CASCADE", "DROP TYPE IF EXISTS public.status"] {
            dst.query(q).await.unwrap();
        }
        let r = restore(dst.as_ref(), &f, &RestoreOptions { stop_on_error: true }, &|_| {}, &NO_CANCEL).await.unwrap();
        assert_eq!(r.failed, 0, "{:?}", r.errors);
        assert_eq!(r.copied_rows, 6, "COPY blocks were loaded");

        for q in [
            "SELECT id, status::text, total, note, placed, photo, tags, total_cents FROM public.orders ORDER BY id",
            "SELECT id, order_id, sku FROM shop.items ORDER BY id",
            "SELECT * FROM public.order_totals ORDER BY status",
        ] {
            assert_eq!(rows(&src, q).await, rows(&dst, q).await, "{q} gzip={gzip}");
        }
        // Structure: constraints, partial index, FK with cascade, enum, schema.
        let d = dst.describe(Some("public"), "orders").await.unwrap();
        assert!(d.index_details.iter().any(|i| i.name == "idx_status"), "{:?}", d.index_details);
        assert!(d.index_details.iter().any(|i| i.primary));
        assert_eq!(dst.describe(Some("shop"), "items").await.unwrap().foreign_keys.len(), 1);
        // Sequences were realigned with the data, for both serial and identity columns.
        dst.query("INSERT INTO public.orders (status) VALUES ('new')").await.unwrap();
        assert_eq!(rows(&dst, "SELECT MAX(id) FROM public.orders").await[0][0], Value::I64(4), "serial resumed after the data");
        dst.query("INSERT INTO shop.items (order_id, sku) VALUES (2, 'D')").await.unwrap();
        assert_eq!(rows(&dst, "SELECT MAX(id) FROM shop.items").await[0][0], Value::I64(4), "identity resumed after the data");
        dst.query("DELETE FROM public.orders WHERE id = 1").await.unwrap();
        assert_eq!(rows(&dst, "SELECT COUNT(*) FROM shop.items").await[0][0], Value::I64(2), "ON DELETE CASCADE preserved");
    }
}
