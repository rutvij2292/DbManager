//! Needs a server: LATTICE_REDIS_PORT=56379 cargo test -p driver-redis -- --ignored
use dbcore::*;
use driver_redis::RedisDriver;

#[tokio::test]
#[ignore]
async fn live_roundtrip() {
    let port: u16 = std::env::var("LATTICE_REDIS_PORT").expect("LATTICE_REDIS_PORT").parse().unwrap();
    let cfg = ConnConfig { kind: "redis".into(), host: Some("127.0.0.1".into()), port: Some(port), ..Default::default() };
    let c = RedisDriver.connect(&cfg).await.unwrap();
    c.query("FLUSHDB").await.unwrap();
    c.query(r#"SET greeting "hello world""#).await.unwrap();
    c.query("RPUSH queue a b c").await.unwrap();
    c.query("HSET user:1 name Ada age 36").await.unwrap();
    c.query("ZADD board 10 x 20 y").await.unwrap();
    c.query("SADD tags red blue").await.unwrap();
    let keys: Vec<String> = c.objects().await.unwrap().into_iter().map(|o| o.name).collect();
    assert_eq!(keys, vec!["board", "greeting", "queue", "tags", "user:1"]);
    assert_eq!(c.query("@view greeting").await.unwrap().rows[0][1], Value::Text("hello world".into()));
    let l = c.query(&c.select_all(None, "queue", 100)).await.unwrap();
    assert_eq!(l.rows.len(), 3);
    assert_eq!(l.rows[2][1], Value::Text("c".into()));
    let h = c.query("@view user:1").await.unwrap();
    assert!(h.rows.iter().any(|r| r[0] == Value::Text("name".into()) && r[1] == Value::Text("Ada".into())));
    let z = c.query("@view board").await.unwrap();
    assert_eq!(z.rows[1][0], Value::Text("y".into()));
    assert_eq!(c.query("@view tags").await.unwrap().rows.len(), 2);
    assert_eq!(c.query("DBSIZE").await.unwrap().rows[0][0], Value::I64(5));
    assert!(c.describe(None, "user:1").await.unwrap().ddl.unwrap().contains("type: hash"));
    assert!(c.query("@view missing").await.is_err());
    assert!(c.query("NOSUCHCOMMAND").await.is_err());
}
