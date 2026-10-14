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
