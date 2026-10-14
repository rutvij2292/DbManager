//! Needs a server: LATTICE_MONGO_PORT=57017 cargo test -p driver-mongo -- --ignored
use dbcore::*;
use driver_mongo::MongoDriver;

#[tokio::test]
#[ignore]
async fn live_roundtrip() {
    let port: u16 = std::env::var("LATTICE_MONGO_PORT").expect("LATTICE_MONGO_PORT").parse().unwrap();
    let cfg = ConnConfig { kind: "mongo".into(), host: Some("127.0.0.1".into()), port: Some(port), database: Some("app".into()), ..Default::default() };
    let c = MongoDriver.connect(&cfg).await.unwrap();
    c.ping().await.unwrap();
    // No write syntax in the driver (read-only), so seed through the official client.
    let client = mongodb::Client::with_uri_str(format!("mongodb://127.0.0.1:{port}")).await.unwrap();
    let coll = client.database("app").collection::<mongodb::bson::Document>("people");
    coll.drop().await.unwrap();
    coll.insert_many(vec![
        mongodb::bson::doc! { "name": "Ada", "age": 36, "tags": ["math"] },
        mongodb::bson::doc! { "name": "Linus", "age": 54.5 },
        mongodb::bson::doc! { "name": "Grace", "age": 85, "extra": true },
    ]).await.unwrap();
    assert!(c.objects().await.unwrap().iter().any(|o| o.name == "people" && o.kind == "collection"));
    let all = c.query(&c.select_all(None, "people", 100)).await.unwrap();
    assert_eq!(all.rows.len(), 3);
    assert_eq!(all.columns[0].name, "_id");
    let name_i = all.columns.iter().position(|c| c.name == "name").unwrap();
    assert!(all.rows.iter().any(|r| r[name_i] == Value::Text("Ada".into())));
    let older = c.query(r#"db.people.find({"age": {"$gt": 50}})"#).await.unwrap();
    assert_eq!(older.rows.len(), 2);
    assert_eq!(c.query("db.people.count()").await.unwrap().rows[0][0], Value::I64(3));
    let agg = c.query(r#"db.people.aggregate([{"$group": {"_id": null, "n": {"$sum": 1}}}])"#).await.unwrap();
    assert_eq!(agg.rows[0][agg.columns.iter().position(|c| c.name == "n").unwrap()], Value::I64(3));
    let d = c.describe(None, "people").await.unwrap();
    assert!(d.columns.iter().any(|c| c.name == "extra") && d.columns.iter().all(|c| !c.primary_key));
    assert!(c.query("db.people.drop()").await.is_err());
    assert!(c.query(r#"db.people.find({bad json"#).await.is_err());
}
