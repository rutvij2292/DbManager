# Lattice — project log

A personal-use, macOS-first, TablePlus-style database client in Rust (Tauri v2 + TypeScript/Tailwind).

## 2026-10-14
- Project named **Lattice**. Architecture reviewed by Fable (async-trait `Driver`/`Connection`, paged results kept in Rust, workspace of per-driver crates).
- `rea-agents` evaluated and not used: TablePlus is a native app (not Electron), and I'm not decompiling it. Behavior and shortcuts are recreated from the public UI and docs; all code is original.
- Step 1: workspace, `dbcore`, `driver-sqlite` (with test).
- Feature survey of installed TablePlus (bundle metadata only, no code copied): drivers = SQLite, LibSQL, Cloudflare D1, DuckDB, PostgreSQL, CockroachDB, Greenplum, Redshift, Vertica, MySQL, MariaDB, MSSQL, Oracle, BigQuery, Snowflake, ClickHouse, MongoDB, Redis, Cassandra, DynamoDB, ElasticSearch. Windows/features: connection groups, SSH tunnel, table structure, filter rules, ER diagram, backup/restore, export, command log, AI chat. Roadmap follows this list.
- Step 2: Tauri v2 shell (`src-tauri`) + Vite/TS/Tailwind UI (`ui`). Unlimited tabs (no cap), CodeMirror 6 editor, virtualized grid that pages rows from Rust (`run_query` + `get_rows`, 200k row cap), object sidebar, ⌘P quick open.
- Shortcuts so far: ⌘T new tab, ⌘W close, ⌘1–9 select tab, ⌘⇧[ / ⌘⇧] prev/next, ⌘Enter run (selection or all), ⌘R reload, ⌘P open quickly, ⌘O / ⌘N connections, ⌘L focus search, ⌘I format SQL.
- Step 3: drivers `driver-postgres` (also CockroachDB/Redshift/Greenplum), `driver-mysql` (also MariaDB). Connection manager UI with saved profiles (JSON in app config dir, passwords in macOS Keychain), Test/Save/Connect. Schema-aware autocomplete per dialect via `schema_map`.
- Known gaps: no TLS for Postgres (NoTls) or SSH tunnel yet; no cancel; results are read-only; UI not visually verified (no screen-capture permission in this session); only the SQLite driver has a test.
- Next: row editing with generated SQL preview, EXPLAIN visualization + lint-based optimizer, visual query builder, TLS/SSH, MSSQL/Redis/Mongo.
