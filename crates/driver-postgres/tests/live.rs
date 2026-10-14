//! Needs a server: LATTICE_PG_PORT=55432 cargo test -p driver-postgres -- --ignored
use dbcore::*;
use driver_postgres::PostgresDriver;

#[tokio::test]
#[ignore]
async fn live_roundtrip() {
    let port: u16 = std::env::var("LATTICE_PG_PORT").expect("LATTICE_PG_PORT").parse().unwrap();
    let cfg = ConnConfig { kind: "postgres".into(), host: Some("127.0.0.1".into()), port: Some(port), user: Some("postgres".into()), password: Some("pw".into()), database: Some("app".into()), ..Default::default() };
    let c = PostgresDriver.connect(&cfg).await.unwrap();
    c.query("DROP TABLE IF EXISTS t").await.unwrap();
    c.query("CREATE TABLE t(id serial PRIMARY KEY, name text NOT NULL, score float8, ok bool)").await.unwrap();
    let r = c.query("INSERT INTO t(name, score, ok) VALUES ('a', 1.5, true), ('b', NULL, false)").await.unwrap();
    assert_eq!(r.affected, Some(2));
    let r = c.query("SELECT id, name, score, ok FROM t ORDER BY id").await.unwrap();
    assert_eq!(r.rows[0], vec![Value::I64(1), Value::Text("a".into()), Value::F64(1.5), Value::Bool(true)]);
    assert_eq!(r.rows[1][2], Value::Null);
    let objs = c.objects().await.unwrap();
    assert!(objs.iter().any(|o| o.name == "t" && o.schema.as_deref() == Some("public")));
    let d = c.describe(Some("public"), "t").await.unwrap();
    assert!(d.columns[0].primary_key && !d.columns[1].nullable);
    assert!(c.schema_map().await.unwrap().iter().any(|t| t.name == "t" && t.columns.len() == 4));
    let plan = c.explain("SELECT * FROM t WHERE id = 1", true).await.unwrap();
    assert!(plan.actual_rows.is_some(), "{plan:?}");
    // Atomic edits: second change matches nothing, so the first must roll back.
    let key = |i| vec![("id".to_string(), Value::I64(i))];
    let bad = [Change::Update { key: key(1), set: vec![("name".into(), Value::Text("zzz".into()))] }, Change::Delete { key: key(99) }];
    assert!(c.execute_batch(&build_dml(c.as_ref(), Some("public"), "t", &bad)).await.is_err());
    assert_eq!(c.query("SELECT name FROM t WHERE id = 1").await.unwrap().rows[0][0], Value::Text("a".into()));
    let good = [Change::Update { key: key(1), set: vec![("name".into(), Value::Text("it's".into()))] }];
    c.execute_batch(&build_dml(c.as_ref(), Some("public"), "t", &good)).await.unwrap();
    assert_eq!(c.query("SELECT name FROM t WHERE id = 1").await.unwrap().rows[0][0], Value::Text("it's".into()));
    // A bad statement surfaces an error rather than panicking.
    assert!(c.query("SELEC 1").await.is_err());
}

#[tokio::test]
#[ignore]
async fn live_cancel() {
    let port: u16 = std::env::var("LATTICE_PG_PORT").expect("LATTICE_PG_PORT").parse().unwrap();
    let cfg = ConnConfig { kind: "postgres".into(), host: Some("127.0.0.1".into()), port: Some(port), user: Some("postgres".into()), password: Some("pw".into()), database: Some("app".into()), ..Default::default() };
    let c = PostgresDriver.connect(&cfg).await.unwrap();
    let c2 = c.clone();
    let started = std::time::Instant::now();
    let long = tokio::spawn(async move { c2.query("SELECT pg_sleep(30)").await });
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    c.cancel().await.unwrap();
    assert!(long.await.unwrap().is_err(), "sleep should have been cancelled");
    assert!(started.elapsed().as_secs() < 10);
    assert_eq!(c.query("SELECT 1").await.unwrap().rows.len(), 1);
}

#[tokio::test]
#[ignore]
async fn live_structure() {
    let port: u16 = std::env::var("LATTICE_PG_PORT").expect("LATTICE_PG_PORT").parse().unwrap();
    let cfg = ConnConfig { kind: "postgres".into(), host: Some("127.0.0.1".into()), port: Some(port), user: Some("postgres".into()), password: Some("pw".into()), database: Some("app".into()), ..Default::default() };
    let c = PostgresDriver.connect(&cfg).await.unwrap();
    for s in ["DROP TABLE IF EXISTS s_child", "DROP TABLE IF EXISTS s_parent", "CREATE TABLE s_parent(id int PRIMARY KEY, code text)",
        "CREATE TABLE s_child(id serial PRIMARY KEY, parent_id int REFERENCES s_parent(id), a text, b text)", "CREATE UNIQUE INDEX s_child_ab ON s_child(a, b)"] {
        c.query(s).await.unwrap();
    }
    let d = c.describe(Some("public"), "s_child").await.unwrap();
    let ix = d.index_details.iter().find(|i| i.name == "s_child_ab").unwrap();
    assert_eq!((ix.columns.clone(), ix.unique, ix.primary), (vec!["a".to_string(), "b".to_string()], true, false));
    assert!(d.index_details.iter().any(|i| i.primary && i.columns == ["id"]));
    assert_eq!(d.foreign_keys.len(), 1);
    assert_eq!((d.foreign_keys[0].ref_table.as_str(), d.foreign_keys[0].columns.clone(), d.foreign_keys[0].ref_columns.clone()), ("s_parent", vec!["parent_id".to_string()], vec!["id".to_string()]));

    let changes = [
        StructChange::AddColumn { name: "score".into(), type_name: "integer".into(), nullable: false, default: Some("0".into()) },
        StructChange::RenameColumn { from: "a".into(), to: "alpha".into() },
        StructChange::AlterColumn { name: "b".into(), type_name: "varchar(40)".into(), nullable: false, default: Some("'x'".into()), old_type: "text".into(), old_nullable: true, old_default: None },
        StructChange::DropIndex { name: "s_child_ab".into() },
        StructChange::CreateIndex { name: "s_child_score".into(), columns: vec!["score".into()], unique: false },
    ];
    let ddl = build_ddl(c.as_ref(), Some("public"), "s_child", &changes).unwrap();
    c.execute_batch(&ddl.iter().map(|s| (s.clone(), None)).collect::<Vec<_>>()).await.unwrap();
    let d = c.describe(Some("public"), "s_child").await.unwrap();
    let col = |n: &str| d.columns.iter().find(|c| c.name == n).unwrap_or_else(|| panic!("no column {n}")).clone();
    assert!(!col("score").nullable && col("alpha").type_name == "text");
    assert!(col("b").type_name.contains("character varying") && !col("b").nullable && col("b").default.unwrap().contains("'x'"));
    assert!(d.index_details.iter().any(|i| i.name == "s_child_score") && !d.index_details.iter().any(|i| i.name == "s_child_ab"));
}
