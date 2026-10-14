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

#[tokio::test]
#[ignore]
async fn live_cancel() {
    let port: u16 = std::env::var("LATTICE_MYSQL_PORT").expect("LATTICE_MYSQL_PORT").parse().unwrap();
    let cfg = ConnConfig { kind: "mysql".into(), host: Some("127.0.0.1".into()), port: Some(port), user: Some("root".into()), password: Some("pw".into()), database: Some("app".into()), ssl: Some("disable".into()), ..Default::default() };
    let c = MysqlDriver.connect(&cfg).await.unwrap();
    let c2 = c.clone();
    let started = std::time::Instant::now();
    // MySQL reports a killed SELECT SLEEP() as a normal row (1) or an error depending on version.
    let long = tokio::spawn(async move { c2.query("SELECT SLEEP(30)").await });
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    c.cancel().await.unwrap();
    let _ = long.await.unwrap();
    assert!(started.elapsed().as_secs() < 10, "query was not interrupted");
    assert_eq!(c.query("SELECT 1").await.unwrap().rows.len(), 1);
}

#[tokio::test]
#[ignore]
async fn live_structure() {
    let port: u16 = std::env::var("LATTICE_MYSQL_PORT").expect("LATTICE_MYSQL_PORT").parse().unwrap();
    let cfg = ConnConfig { kind: "mysql".into(), host: Some("127.0.0.1".into()), port: Some(port), user: Some("root".into()), password: Some("pw".into()), database: Some("app".into()), ssl: Some("disable".into()), ..Default::default() };
    let c = MysqlDriver.connect(&cfg).await.unwrap();
    for s in ["DROP TABLE IF EXISTS s_child", "DROP TABLE IF EXISTS s_parent", "CREATE TABLE s_parent(id int PRIMARY KEY, code varchar(10))",
        "CREATE TABLE s_child(id int AUTO_INCREMENT PRIMARY KEY, parent_id int, a varchar(20), b varchar(20), CONSTRAINT fk_p FOREIGN KEY (parent_id) REFERENCES s_parent(id))", "CREATE UNIQUE INDEX s_child_ab ON s_child(a, b)"] {
        c.query(s).await.unwrap();
    }
    let d = c.describe(None, "s_child").await.unwrap();
    let ix = d.index_details.iter().find(|i| i.name == "s_child_ab").unwrap();
    assert_eq!((ix.columns.clone(), ix.unique), (vec!["a".to_string(), "b".to_string()], true));
    assert!(d.index_details.iter().any(|i| i.primary));
    let fk = d.foreign_keys.iter().find(|f| f.name == "fk_p").unwrap();
    assert_eq!((fk.ref_table.as_str(), fk.columns.clone(), fk.ref_columns.clone()), ("s_parent", vec!["parent_id".to_string()], vec!["id".to_string()]));

    let changes = [
        StructChange::AddColumn { name: "score".into(), type_name: "int".into(), nullable: false, default: Some("0".into()) },
        StructChange::RenameColumn { from: "a".into(), to: "alpha".into() },
        StructChange::AlterColumn { name: "b".into(), type_name: "varchar(40)".into(), nullable: false, default: Some("'x'".into()), old_type: "varchar(20)".into(), old_nullable: true, old_default: None },
        StructChange::DropIndex { name: "s_child_ab".into() },
        StructChange::CreateIndex { name: "s_child_score".into(), columns: vec!["score".into()], unique: false },
    ];
    let ddl = build_ddl(c.as_ref(), None, "s_child", &changes).unwrap();
    c.execute_batch(&ddl.iter().map(|s| (s.clone(), None)).collect::<Vec<_>>()).await.unwrap();
    let d = c.describe(None, "s_child").await.unwrap();
    let col = |n: &str| d.columns.iter().find(|c| c.name == n).unwrap_or_else(|| panic!("no column {n}")).clone();
    assert!(!col("score").nullable && col("alpha").type_name.starts_with("varchar(20)"));
    assert!(col("b").type_name.starts_with("varchar(40)") && !col("b").nullable && col("b").default.as_deref() == Some("x"));
    assert!(d.index_details.iter().any(|i| i.name == "s_child_score") && !d.index_details.iter().any(|i| i.name == "s_child_ab"));
}

/// The bug: a connection saved without a database (typical for imported TablePlus connections)
/// showed nothing. It must list the server's databases, and reopening one must expose its tables.
#[tokio::test]
#[ignore]
async fn live_connection_without_database_lists_and_switches() {
    let port: u16 = std::env::var("LATTICE_MYSQL_PORT").expect("LATTICE_MYSQL_PORT").parse().unwrap();
    let base = ConnConfig { kind: "mysql".into(), host: Some("127.0.0.1".into()), port: Some(port), user: Some("root".into()), password: Some("pw".into()), ssl: Some("disable".into()), ..Default::default() };
    let c = MysqlDriver.connect(&base).await.unwrap();
    let dbs = c.databases().await.unwrap();
    assert!(dbs.iter().any(|d| d == "shop") && dbs.iter().any(|d| d == "analytics"), "{dbs:?}");
    assert!(dbs.iter().any(|d| d == "information_schema"), "system databases are listed too");
    assert!(c.objects().await.unwrap().is_empty(), "no database selected, so no tables");

    let shop = MysqlDriver.connect(&ConnConfig { database: Some("shop".into()), ..base.clone() }).await.unwrap();
    let names: Vec<_> = shop.objects().await.unwrap().into_iter().map(|o| o.name).collect();
    assert_eq!(names, ["customers", "orders"]);
    let ana = MysqlDriver.connect(&ConnConfig { database: Some("analytics".into()), ..base }).await.unwrap();
    assert_eq!(ana.objects().await.unwrap()[0].name, "events");
}
