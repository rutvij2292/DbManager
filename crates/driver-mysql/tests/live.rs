//! Needs a server: LATTICE_MYSQL_PORT=53306 cargo test -p driver-mysql -- --ignored
use dbcore::*;
use driver_mysql::MysqlDriver;

#[tokio::test]
#[ignore]
async fn live_roundtrip() {
    let port: u16 = std::env::var("LATTICE_MYSQL_PORT").expect("LATTICE_MYSQL_PORT").parse().unwrap();
    let cfg = ConnConfig { kind: "mysql".into(), host: Some("127.0.0.1".into()), port: Some(port), user: Some("root".into()), password: Some("pw".into()), database: Some("app".into()), ssl: Some("disable".into()), ..Default::default() };
    let c = MysqlDriver.connect(&cfg).await.unwrap();
    c.query("DROP TABLE IF EXISTS t").await.unwrap();
    c.query("CREATE TABLE t(id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) NOT NULL, score DOUBLE, d DATE)").await.unwrap();
    let r = c.query("INSERT INTO t(name, score, d) VALUES ('a', 1.5, '2024-01-02'), ('b', NULL, NULL)").await.unwrap();
    assert_eq!(r.affected, Some(2));
    let r = c.query("SELECT id, name, score, d FROM t ORDER BY id").await.unwrap();
    assert_eq!(r.rows[0], vec![Value::I64(1), Value::Text("a".into()), Value::F64(1.5), Value::Text("2024-01-02".into())]);
    assert_eq!(r.rows[1][2], Value::Null);
    assert!(c.objects().await.unwrap().iter().any(|o| o.name == "t"));
    let d = c.describe(None, "t").await.unwrap();
    assert!(d.columns[0].primary_key && !d.columns[1].nullable);
    assert!(d.ddl.unwrap_or_default().contains("CREATE TABLE"));
    assert!(c.schema_map().await.unwrap().iter().any(|t| t.name == "t" && t.columns.len() == 4));
    assert!(!c.explain("SELECT * FROM t", false).await.unwrap().children.is_empty());
    let key = |i| vec![("id".to_string(), Value::I64(i))];
    let bad = [Change::Update { key: key(1), set: vec![("name".into(), Value::Text("zzz".into()))] }, Change::Delete { key: key(99) }];
    assert!(c.execute_batch(&build_dml(c.as_ref(), None, "t", &bad)).await.is_err());
    assert_eq!(c.query("SELECT name FROM t WHERE id = 1").await.unwrap().rows[0][0], Value::Text("a".into()));
    let good = [Change::Update { key: key(1), set: vec![("name".into(), Value::Text("it's \\ ok".into()))] }];
    c.execute_batch(&build_dml(c.as_ref(), None, "t", &good)).await.unwrap();
    assert_eq!(c.query("SELECT name FROM t WHERE id = 1").await.unwrap().rows[0][0], Value::Text("it's \\ ok".into()));
    assert!(c.query("SELEC 1").await.is_err());
}
