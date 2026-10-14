use std::io::{self, BufRead};

/// One executable unit of a SQL script.
#[derive(Debug, PartialEq)]
pub enum Item {
    Statement(String),
    /// `COPY … FROM stdin;` followed by its raw data lines (without the terminating `\.`).
    Copy { statement: String, data: Vec<u8> },
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Normal,
    Single { backslash: bool },
    Double,
    Backtick,
    Block,
}

/// Streaming statement splitter. It knows enough SQL lexing to not split inside strings,
/// quoted identifiers, comments or `$tag$ … $tag$` bodies.
pub struct ScriptReader<R: BufRead> {
    r: R,
    delimiter: String,
    /// MySQL treats a backslash inside a string as an escape; Postgres (standard strings) does not.
    backslash_strings: bool,
    postgres: bool,
    sqlite: bool,
    mode: Mode,
    dollar: Option<String>,
    buf: String,
    pending: std::collections::VecDeque<String>,
    pub bytes_read: u64,
}

impl<R: BufRead> ScriptReader<R> {
    pub fn new(r: R, dialect: &str) -> Self {
        ScriptReader {
            r,
            delimiter: ";".into(),
            backslash_strings: dialect == "mysql",
            postgres: dialect == "postgres",
            sqlite: dialect == "sqlite",
            mode: Mode::Normal,
            dollar: None,
            buf: String::new(),
            pending: Default::default(),
            bytes_read: 0,
        }
    }

    /// Next statement or COPY block; `None` at end of input.
    pub fn next_item(&mut self) -> io::Result<Option<Item>> {
        loop {
            if let Some(stmt) = self.pending.pop_front() {
                if self.postgres && is_copy_stdin(&stmt) {
                    return Ok(Some(Item::Copy { data: self.read_copy_data()?, statement: stmt }));
                }
                return Ok(Some(Item::Statement(stmt)));
            }
            let mut line = String::new();
            let n = self.r.read_line(&mut line)?;
            if n == 0 {
                // End of input: whatever is left is a final statement without a terminator.
                let rest = std::mem::take(&mut self.buf);
                let rest = rest.trim();
                return Ok(if rest.is_empty() { None } else { Some(Item::Statement(rest.to_string())) });
            }
            self.bytes_read += n as u64;
            self.feed(&line);
        }
    }

    fn read_copy_data(&mut self) -> io::Result<Vec<u8>> {
        let mut data = Vec::new();
        loop {
            let mut line = String::new();
            let n = self.r.read_line(&mut line)?;
            if n == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "COPY data block was not terminated by \\."));
            }
            self.bytes_read += n as u64;
            if line.trim_end_matches(['\r', '\n']) == "\\." {
                return Ok(data);
            }
            data.extend_from_slice(line.as_bytes());
        }
    }

    fn feed(&mut self, line: &str) {
        // `DELIMITER //` is a client command, only valid between statements.
        if self.mode == Mode::Normal && self.buf.trim().is_empty() {
            let t = line.trim();
            if t.len() > 10 && t[..10].eq_ignore_ascii_case("delimiter ") {
                self.delimiter = t[10..].trim().to_string();
                self.buf.clear();
                return;
            }
        }
        let chars: Vec<char> = line.chars().collect();
        let delim: Vec<char> = self.delimiter.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            match self.mode {
                Mode::Normal => {
                    if let Some(tag) = self.dollar.clone() {
                        // inside $tag$ … $tag$
                        if c == '$' && chars[i..].iter().collect::<String>().starts_with(&tag) {
                            self.buf.push_str(&tag);
                            i += tag.chars().count();
                            self.dollar = None;
                            continue;
                        }
                        self.buf.push(c);
                        i += 1;
                        continue;
                    }
                    if chars[i..].starts_with(&delim) && !delim.is_empty() && !(self.sqlite && inside_trigger_body(&self.buf)) {
                        let stmt = std::mem::take(&mut self.buf);
                        let stmt = stmt.trim();
                        if !stmt.is_empty() {
                            self.pending.push_back(stmt.to_string());
                        }
                        i += delim.len();
                        continue;
                    }
                    match c {
                        '\'' => {
                            // E'…' strings honour backslash escapes even in Postgres
                            let prev = self.buf.chars().last();
                            let before = self.buf.chars().rev().nth(1);
                            let e_string = matches!(prev, Some('E') | Some('e')) && !before.map_or(false, |b| b.is_alphanumeric() || b == '_');
                            self.mode = Mode::Single { backslash: self.backslash_strings || e_string };
                            self.buf.push(c);
                        }
                        '"' => { self.mode = Mode::Double; self.buf.push(c); }
                        '`' => { self.mode = Mode::Backtick; self.buf.push(c); }
                        '-' if chars.get(i + 1) == Some(&'-') => {
                            // line comment: drop the rest of the line but keep a line break so tokens don't fuse
                            if !self.buf.trim().is_empty() { self.buf.push('\n'); }
                            break;
                        }
                        '#' if !self.postgres && self.buf.trim().is_empty() => break,
                        '/' if chars.get(i + 1) == Some(&'*') => {
                            // keep MySQL conditional comments (/*! … */): they contain real statements
                            if chars.get(i + 2) == Some(&'!') {
                                self.mode = Mode::Block;
                                self.buf.push_str("/*");
                                i += 2;
                                continue;
                            }
                            self.mode = Mode::Block;
                            i += 2;
                            continue;
                        }
                        '$' if self.postgres && !self.buf.chars().last().map_or(false, |p| p.is_alphanumeric() || p == '_') => {
                            // $tag$ opening?
                            let mut j = i + 1;
                            while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') && !(j == i + 1 && chars[j].is_ascii_digit()) { j += 1; }
                            if j < chars.len() && chars[j] == '$' {
                                let tag: String = chars[i..=j].iter().collect();
                                self.buf.push_str(&tag);
                                self.dollar = Some(tag);
                                i = j + 1;
                                continue;
                            }
                            self.buf.push(c);
                        }
                        _ => self.buf.push(c),
                    }
                }
                Mode::Single { backslash } => {
                    self.buf.push(c);
                    if backslash && c == '\\' {
                        if let Some(&n) = chars.get(i + 1) { self.buf.push(n); i += 2; continue; }
                    } else if c == '\'' {
                        if chars.get(i + 1) == Some(&'\'') { self.buf.push('\''); i += 2; continue; }
                        self.mode = Mode::Normal;
                    }
                }
                Mode::Double => {
                    self.buf.push(c);
                    if self.backslash_strings && c == '\\' {
                        if let Some(&n) = chars.get(i + 1) { self.buf.push(n); i += 2; continue; }
                    } else if c == '"' {
                        if chars.get(i + 1) == Some(&'"') { self.buf.push('"'); i += 2; continue; }
                        self.mode = Mode::Normal;
                    }
                }
                Mode::Backtick => {
                    self.buf.push(c);
                    if c == '`' {
                        if chars.get(i + 1) == Some(&'`') { self.buf.push('`'); i += 2; continue; }
                        self.mode = Mode::Normal;
                    }
                }
                Mode::Block => {
                    // Executable /*! … */ comments are kept verbatim; ordinary ones are dropped.
                    let keep = self.buf.ends_with("/*") || self.buf.contains("/*!") && !self.buf.trim_end().ends_with("*/");
                    if c == '*' && chars.get(i + 1) == Some(&'/') {
                        if keep { self.buf.push_str("*/"); } else { self.buf.push(' '); }
                        i += 2;
                        self.mode = Mode::Normal;
                        continue;
                    }
                    if keep { self.buf.push(c); }
                }
            }
            i += 1;
        }
    }
}

/// True while a SQLite `CREATE TRIGGER … BEGIN … END` body is still open, so its inner `;` don't end the statement.
/// Counts BEGIN/CASE against END outside string literals.
fn inside_trigger_body(buf: &str) -> bool {
    let up = buf.trim_start().to_ascii_uppercase();
    if !(up.starts_with("CREATE TRIGGER") || up.starts_with("CREATE TEMP TRIGGER") || up.starts_with("CREATE TEMPORARY TRIGGER")) {
        return false;
    }
    let (mut depth, mut seen_begin, mut in_str) = (0i32, false, false);
    let mut word = String::new();
    let flush = |w: &mut String, depth: &mut i32, seen: &mut bool| {
        match w.as_str() {
            "BEGIN" => { *depth += 1; *seen = true; }
            "CASE" => *depth += 1,
            "END" => *depth -= 1,
            _ => {}
        }
        w.clear();
    };
    for c in up.chars() {
        if c == '\'' { in_str = !in_str; flush(&mut word, &mut depth, &mut seen_begin); continue; }
        if in_str { continue; }
        if c.is_alphanumeric() || c == '_' { word.push(c); } else { flush(&mut word, &mut depth, &mut seen_begin); }
    }
    flush(&mut word, &mut depth, &mut seen_begin);
    seen_begin && depth > 0
}

fn is_copy_stdin(stmt: &str) -> bool {
    let t = stmt.trim_start();
    t.len() > 5 && t[..4].eq_ignore_ascii_case("copy") && t.to_ascii_lowercase().contains("from stdin")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(sql: &str, dialect: &str) -> Vec<Item> {
        let mut r = ScriptReader::new(sql.as_bytes(), dialect);
        let mut out = Vec::new();
        while let Some(i) = r.next_item().unwrap() { out.push(i); }
        out
    }
    fn stmts(sql: &str, dialect: &str) -> Vec<String> {
        all(sql, dialect).into_iter().map(|i| match i { Item::Statement(s) => s, Item::Copy { statement, .. } => format!("COPY:{statement}") }).collect()
    }

    #[test]
    fn splits_on_semicolons_but_not_inside_strings_identifiers_or_comments() {
        let sql = "-- header; not a statement\nCREATE TABLE a (x text DEFAULT 'a;b');\nINSERT INTO a VALUES ('it''s; ok'), (\"q;\");\n/* block; comment */ SELECT `col;name` FROM a;\n";
        assert_eq!(stmts(sql, "sqlite"), vec![
            "CREATE TABLE a (x text DEFAULT 'a;b')",
            "INSERT INTO a VALUES ('it''s; ok'), (\"q;\")",
            "SELECT `col;name` FROM a",
        ]);
    }

    #[test]
    fn multiline_statements_and_strings_keep_their_newlines() {
        let sql = "INSERT INTO t VALUES ('line one\nline two');\nCREATE TABLE b (\n  id int,\n  n text\n);\n";
        let s = stmts(sql, "postgres");
        assert_eq!(s[0], "INSERT INTO t VALUES ('line one\nline two')");
        assert_eq!(s[1], "CREATE TABLE b (\n  id int,\n  n text\n)");
    }

    #[test]
    fn mysql_backslash_escapes_and_conditional_comments() {
        let s = stmts("INSERT INTO t VALUES ('it\\'s; fine');\n/*!40101 SET NAMES utf8mb4 */;\n", "mysql");
        assert_eq!(s[0], "INSERT INTO t VALUES ('it\\'s; fine')");
        assert_eq!(s[1], "/*!40101 SET NAMES utf8mb4 */");
        // In Postgres standard strings a backslash is an ordinary character.
        let p = stmts("SELECT 'C:\\'; SELECT 2;", "postgres");
        assert_eq!(p, vec!["SELECT 'C:\\'", "SELECT 2"]);
    }

    #[test]
    fn mysql_delimiter_blocks() {
        let sql = "DELIMITER //\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND//\nDELIMITER ;\nSELECT 3;\n";
        let s = stmts(sql, "mysql");
        assert_eq!(s.len(), 2, "{s:?}");
        assert!(s[0].starts_with("CREATE PROCEDURE") && s[0].contains("SELECT 1;") && s[0].ends_with("END"));
        assert_eq!(s[1], "SELECT 3");
    }

    #[test]
    fn postgres_dollar_quotes_and_copy_blocks() {
        let sql = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\nCREATE FUNCTION g() RETURNS int AS $body$ SELECT ';'; $body$ LANGUAGE sql;\nSELECT $1;\nCOPY public.t (a, b) FROM stdin;\n1\tx;y\n2\t\\N\n\\.\nSELECT 9;\n";
        let items = all(sql, "postgres");
        assert_eq!(items.len(), 5, "{items:?}");
        assert!(matches!(&items[0], Item::Statement(s) if s.contains("RETURN 1; END;")));
        assert!(matches!(&items[1], Item::Statement(s) if s.contains("SELECT ';';")));
        assert_eq!(items[2], Item::Statement("SELECT $1".into()));
        match &items[3] {
            Item::Copy { statement, data } => {
                assert!(statement.starts_with("COPY public.t"));
                assert_eq!(String::from_utf8_lossy(data), "1\tx;y\n2\t\\N\n");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(items[4], Item::Statement("SELECT 9".into()));
    }

    #[test]
    fn dropped_comments_do_not_fuse_neighbouring_tokens() {
        assert_eq!(stmts("SELECT a--note\nFROM t;", "sqlite"), vec!["SELECT a\nFROM t"]);
        assert_eq!(stmts("SELECT a/*note*/FROM t;", "sqlite"), vec!["SELECT a FROM t"]);
        assert_eq!(stmts("CREATE TABLE t (\n  a int, -- first\n  b int -- last\n);", "sqlite").len(), 1);
    }

    #[test]
    fn sqlite_trigger_bodies_are_one_statement() {
        let sql = "CREATE TRIGGER t1 AFTER INSERT ON a BEGIN UPDATE b SET n = CASE WHEN 1 THEN 2 END; SELECT 'x;y'; END;\nCREATE TABLE z(i int);\n";
        let s = stmts(sql, "sqlite");
        assert_eq!(s.len(), 2, "{s:?}");
        assert!(s[0].starts_with("CREATE TRIGGER t1") && s[0].ends_with("END"));
        assert_eq!(s[1], "CREATE TABLE z(i int)");
    }

    #[test]
    fn unterminated_last_statement_and_empty_input() {
        assert_eq!(stmts("SELECT 1; SELECT 2", "sqlite"), vec!["SELECT 1", "SELECT 2"]);
        assert!(stmts("", "sqlite").is_empty());
        assert!(stmts("-- only a comment\n/* and a block */\n", "sqlite").is_empty());
    }
}
