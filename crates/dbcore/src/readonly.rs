//! Is a piece of SQL safe to run on a read-only connection? A deliberately strict, dependency-free check:
//! anything that is not clearly a read is refused (a wrongly refused statement is a nuisance, a wrongly
//! allowed one defeats the whole point of read-only mode).

/// Blank out comments and string/identifier literals so keywords inside them are not mistaken for SQL.
fn scrub(sql: &str) -> String {
    let b: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();
        if c == '-' && next == Some('-') || c == '#' {
            while i < b.len() && b[i] != '\n' { i += 1; }
        } else if c == '/' && next == Some('*') {
            i += 2;
            while i < b.len() && !(b[i] == '*' && b.get(i + 1) == Some(&'/')) { i += 1; }
            i += 2;
            out.push(' ');
        } else if c == '\'' || c == '"' || c == '`' {
            i += 1;
            while i < b.len() {
                if b[i] == '\\' && c != '`' { i += 2; continue; }
                if b[i] == c { if b.get(i + 1) == Some(&c) { i += 2; continue; } break; }
                i += 1;
            }
            i += 1;
            out.push_str(" _ ");
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

const WRITE_WORDS: &[&str] = &[
    "insert", "update", "delete", "replace", "merge", "drop", "create", "alter", "truncate", "grant", "revoke", "rename",
    "call", "exec", "execute", "into", "copy", "load", "lock", "vacuum", "reindex", "attach", "detach", "set", "do", "handler",
];

fn words(s: &str) -> impl Iterator<Item = String> + '_ {
    s.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty()).map(|w| w.to_lowercase())
}

fn statement_is_read(st: &str) -> bool {
    let mut w = words(st);
    let Some(first) = w.next() else { return true };
    match first.as_str() {
        "show" | "describe" | "desc" | "use" | "values" | "table" | "begin" | "start" | "commit" | "rollback" => {
            // `use` / transaction control change no data; the rest are plain reads.
            first != "start" || w.next().as_deref() == Some("transaction")
        }
        "select" | "with" | "explain" => !words(st).skip(1).any(|x| WRITE_WORDS.contains(&x.as_str()) && !(x == "set" && first == "explain")),
        // SQLite: `PRAGMA name` reads; `PRAGMA name = value` / `PRAGMA name(value)` can write.
        "pragma" => !st.contains('=') && !st.contains('('),
        _ => false,
    }
}

/// True when every statement in `sql` is a read.
pub fn is_read_only_sql(sql: &str) -> bool {
    scrub(sql).split(';').all(|st| statement_is_read(st.trim()))
}

#[cfg(test)]
mod tests {
    use super::is_read_only_sql as ro;

    #[test]
    fn reads_are_allowed() {
        for q in ["SELECT * FROM t", "  select 1;", "SHOW TABLES", "describe users", "EXPLAIN SELECT * FROM t", "WITH x AS (SELECT 1) SELECT * FROM x", "select 'insert into x' as s", "-- drop table x\nselect 1", "/* delete */ select 1", "PRAGMA table_info(t)".replace("(t)", "").as_str(), "SELECT `update` FROM t", "", "   ;  "] {
            assert!(ro(q), "should be read-only: {q}");
        }
    }

    #[test]
    fn writes_are_refused() {
        for q in [
            "INSERT INTO t VALUES (1)", "update t set a = 1", "DELETE FROM t", "drop table t", "TRUNCATE t", "create table x (a int)", "alter table t add b int",
            "select 1; delete from t", "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", "select * into newt from t", "SELECT * FROM t INTO OUTFILE '/tmp/x'",
            "explain analyze delete from t", "call do_things()", "SET foreign_key_checks = 0", "PRAGMA journal_mode = off", "REPLACE INTO t VALUES (1)", "grant all on t to u", "vacuum", "copy t from stdin",
        ] {
            assert!(!ro(q), "should be refused: {q}");
        }
    }
}
