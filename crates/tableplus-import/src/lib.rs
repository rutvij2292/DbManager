//! Read the connection list that TablePlus keeps in `Connections.plist` so users can migrate
//! without retyping. Only connection settings are read here; passwords live in the macOS Keychain
//! (account `<id>_database`) and are fetched separately, with the user's consent.
use serde::{Deserialize, Serialize};

/// Where TablePlus stores its connections on macOS, relative to the home directory.
pub const CONNECTIONS_PATH: &str = "Library/Application Support/com.tinyapp.TablePlus/Data/Connections.plist";
/// Keychain service TablePlus uses for passwords.
pub const KEYCHAIN_SERVICE: &str = "com.tableplus.TablePlus";

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct Raw {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "ConnectionName")]
    name: String,
    #[serde(rename = "Driver")]
    driver: String,
    #[serde(rename = "DatabaseHost")]
    host: String,
    #[serde(rename = "DatabasePort")]
    port: String,
    #[serde(rename = "DatabaseUser")]
    user: String,
    #[serde(rename = "DatabaseName")]
    database: String,
    #[serde(rename = "DatabasePath")]
    path: String,
    #[serde(rename = "DatabaseSocket")]
    socket: String,
    #[serde(rename = "isUseSocket")]
    use_socket: bool,
    #[serde(rename = "isOverSSH")]
    over_ssh: bool,
    #[serde(rename = "ServerAddress")]
    ssh_host: String,
    #[serde(rename = "ServerPort")]
    ssh_port: String,
    #[serde(rename = "ServerUser")]
    ssh_user: String,
    #[serde(rename = "isUsePrivateKey")]
    use_key: bool,
    #[serde(rename = "ServerPrivateKeyName")]
    ssh_key: String,
    #[serde(rename = "tLSMode")]
    tls_mode: i64,
    #[serde(rename = "Enviroment")] // sic — TablePlus misspells this key
    environment: String,
    #[serde(rename = "statusColor")]
    color: String,
}

/// A TablePlus connection translated to Lattice's vocabulary.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Imported {
    pub id: String,
    pub name: String,
    /// Lattice driver kind, or `None` when this engine isn't supported yet.
    pub kind: Option<String>,
    /// The driver name as TablePlus calls it.
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub database: Option<String>,
    pub path: Option<String>,
    pub socket: Option<String>,
    pub ssl: Option<String>,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_user: Option<String>,
    pub ssh_key: Option<String>,
    pub environment: Option<String>,
    pub color: Option<String>,
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// Map TablePlus driver names onto Lattice kinds.
pub fn kind_of(driver: &str) -> Option<&'static str> {
    let d = driver.to_ascii_lowercase();
    Some(if d.contains("mariadb") {
        "mariadb"
    } else if d.contains("mysql") {
        "mysql"
    } else if d.contains("cockroach") {
        "cockroach"
    } else if d.contains("redshift") {
        "redshift"
    } else if d.contains("greenplum") {
        "greenplum"
    } else if d.contains("postgres") {
        "postgres"
    } else if d.contains("sqlite") {
        "sqlite"
    } else if d.contains("sql server") || d.contains("mssql") || d.contains("sqlserver") {
        "mssql"
    } else if d.contains("redis") {
        "redis"
    } else if d.contains("mongo") {
        "mongo"
    } else {
        return None;
    })
}

/// TablePlus' `tLSMode`: 0 = off/automatic, 1 = preferred, 2 = required, 3+ = verify certificate.
fn ssl_of(mode: i64) -> Option<String> {
    match mode {
        i64::MIN..=1 => None, // leave Lattice's default (prefer)
        2 => Some("require".into()),
        _ => Some("verify".into()),
    }
}

/// Parse the bytes of a `Connections.plist` (XML or binary).
pub fn parse(bytes: &[u8]) -> Result<Vec<Imported>, String> {
    let raws: Vec<Raw> = plist::from_bytes(bytes).map_err(|e| format!("not a TablePlus connections file: {e}"))?;
    Ok(raws
        .into_iter()
        .filter(|r| !r.id.is_empty())
        .map(|r| {
            let ssh = r.over_ssh && !r.ssh_host.trim().is_empty();
            Imported {
                kind: kind_of(&r.driver).map(String::from),
                name: non_empty(&r.name).unwrap_or_else(|| r.host.clone()),
                host: non_empty(&r.host),
                port: r.port.trim().parse().ok(),
                user: non_empty(&r.user),
                database: non_empty(&r.database),
                path: non_empty(&r.path),
                socket: if r.use_socket { non_empty(&r.socket) } else { None },
                ssl: ssl_of(r.tls_mode),
                ssh_host: ssh.then(|| non_empty(&r.ssh_host)).flatten(),
                ssh_port: ssh.then(|| r.ssh_port.trim().parse().ok()).flatten(),
                ssh_user: ssh.then(|| non_empty(&r.ssh_user)).flatten(),
                ssh_key: (ssh && r.use_key).then(|| non_empty(&r.ssh_key)).flatten(),
                environment: non_empty(&r.environment),
                // TablePlus' default "no colour" is near-white; don't carry it over.
                color: non_empty(&r.color).filter(|c| !c.eq_ignore_ascii_case("#F8F8F8")),
                driver: r.driver,
                id: r.id,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Synthetic data in the same shape TablePlus writes; contains no real connection.
    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array>
<dict>
  <key>ID</key><string>AAAA-1</string><key>ConnectionName</key><string>Local MySQL</string>
  <key>Driver</key><string>MySQL</string><key>DatabaseHost</key><string>127.0.0.1</string>
  <key>DatabasePort</key><string>3307</string><key>DatabaseUser</key><string>root</string>
  <key>DatabaseName</key><string>shop</string><key>isOverSSH</key><false/>
  <key>tLSMode</key><integer>0</integer><key>Enviroment</key><string>local</string>
  <key>statusColor</key><string>#F8F8F8</string><key>SomethingNew</key><string>ignored</string>
</dict>
<dict>
  <key>ID</key><string>BBBB-2</string><key>ConnectionName</key><string>Prod PG via bastion</string>
  <key>Driver</key><string>PostgreSQL</string><key>DatabaseHost</key><string>db.internal</string>
  <key>DatabasePort</key><string>5432</string><key>DatabaseUser</key><string>app</string>
  <key>isOverSSH</key><true/><key>ServerAddress</key><string>bastion.example.com</string>
  <key>ServerPort</key><string>2222</string><key>ServerUser</key><string>deploy</string>
  <key>isUsePrivateKey</key><true/><key>ServerPrivateKeyName</key><string>/Users/me/.ssh/id_ed25519</string>
  <key>tLSMode</key><integer>3</integer><key>Enviroment</key><string>production</string>
  <key>statusColor</key><string>#E04B4B</string>
</dict>
<dict>
  <key>ID</key><string>CCCC-3</string><key>ConnectionName</key><string>Notes db</string>
  <key>Driver</key><string>SQLite</string><key>DatabasePath</key><string>/tmp/notes.sqlite</string>
</dict>
<dict>
  <key>ID</key><string>DDDD-4</string><key>ConnectionName</key><string>Socket MySQL</string>
  <key>Driver</key><string>MariaDB</string><key>isUseSocket</key><true/>
  <key>DatabaseSocket</key><string>/tmp/mysql.sock</string><key>DatabaseHost</key><string>localhost</string>
</dict>
<dict>
  <key>ID</key><string>EEEE-5</string><key>ConnectionName</key><string>Warehouse</string>
  <key>Driver</key><string>Snowflake</string>
</dict>
<dict><key>ConnectionName</key><string>no id, skipped</string></dict>
</array></plist>"#;

    #[test]
    fn parses_mysql_postgres_sqlite_socket_and_unsupported() {
        let v = parse(SAMPLE.as_bytes()).unwrap();
        assert_eq!(v.len(), 5, "entry without an ID is skipped");

        let my = &v[0];
        assert_eq!((my.kind.as_deref(), my.host.as_deref(), my.port, my.user.as_deref(), my.database.as_deref()), (Some("mysql"), Some("127.0.0.1"), Some(3307), Some("root"), Some("shop")));
        assert_eq!((my.ssl.as_deref(), my.color.as_deref(), my.environment.as_deref()), (None, None, Some("local")));
        assert!(my.ssh_host.is_none());

        let pg = &v[1];
        assert_eq!(pg.kind.as_deref(), Some("postgres"));
        assert_eq!((pg.ssh_host.as_deref(), pg.ssh_port, pg.ssh_user.as_deref(), pg.ssh_key.as_deref()), (Some("bastion.example.com"), Some(2222), Some("deploy"), Some("/Users/me/.ssh/id_ed25519")));
        assert_eq!((pg.ssl.as_deref(), pg.color.as_deref(), pg.environment.as_deref()), (Some("verify"), Some("#E04B4B"), Some("production")));

        assert_eq!((v[2].kind.as_deref(), v[2].path.as_deref()), (Some("sqlite"), Some("/tmp/notes.sqlite")));
        assert_eq!((v[3].kind.as_deref(), v[3].socket.as_deref()), (Some("mariadb"), Some("/tmp/mysql.sock")));
        assert_eq!((v[4].kind.clone(), v[4].driver.as_str()), (None, "Snowflake"));
    }

    #[test]
    fn driver_names_map_to_kinds() {
        for (d, k) in [("MySQL", "mysql"), ("MariaDB", "mariadb"), ("PostgreSQL", "postgres"), ("CockroachDB", "cockroach"), ("Amazon Redshift", "redshift"), ("Microsoft SQL Server", "mssql"), ("Redis", "redis"), ("MongoDB", "mongo"), ("SQLite", "sqlite")] {
            assert_eq!(kind_of(d), Some(k), "{d}");
        }
        assert_eq!(kind_of("Oracle"), None);
    }

    #[test]
    fn garbage_is_a_clear_error() {
        assert!(parse(b"not a plist").unwrap_err().contains("not a TablePlus connections file"));
    }
}
