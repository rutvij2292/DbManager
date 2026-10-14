#!/usr/bin/env bash
# Deterministic SQLite fixture for scripts/memprofile.sh: 100 small tables (t000..t099), ten wide 60-column tables
# with 1000+ rows (w00..w09, like real business tables) + one 200k-row table (big).
# Usage: memfixture.sh [path]   (default: bench/mem.db; skipped when it already exists)
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${1:-bench/mem.db}"
[ -f "$DB" ] && exit 0
mkdir -p "$(dirname "$DB")"
{
  echo "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; BEGIN;"
  for i in $(seq 0 99); do
    n=$(printf 't%03d' "$i")
    echo "CREATE TABLE $n (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER, price REAL, note TEXT);"
    echo "INSERT INTO $n WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM s WHERE x<100) SELECT x, 'name-'||x, x*7%1000, x*1.37, 'note '||(x*31%977) FROM s;"
  done
  for i in $(seq 0 9); do
    n=$(printf 'w%02d' "$i")
    cols=$(for c in $(seq 1 59); do if [ $((c % 3)) = 0 ]; then printf ', c%02d INTEGER' "$c"; elif [ $((c % 3)) = 1 ]; then printf ', c%02d TEXT' "$c"; else printf ', c%02d REAL' "$c"; fi; done)
    vals=$(for c in $(seq 1 59); do if [ $((c % 3)) = 0 ]; then printf ', x*%d%%1000' "$c"; elif [ $((c % 3)) = 1 ]; then printf ", 'value-%d-'||x||'-some longer text'" "$c"; else printf ', x*%d.37' "$c"; fi; done)
    echo "CREATE TABLE $n (id INTEGER PRIMARY KEY$cols);"
    echo "INSERT INTO $n WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM s WHERE x<3000) SELECT x$vals FROM s;"
  done
  cat <<'SQL'
CREATE TABLE big (id INTEGER PRIMARY KEY, uid TEXT, name TEXT, email TEXT, qty INTEGER, price REAL, created TEXT, note TEXT);
INSERT INTO big WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM s WHERE x<200000)
  SELECT x, printf('%08x-%04x', x*2654435761%4294967296, x%65536), 'customer '||x%5000, 'user'||x||'@example.com',
         x*7%1000, round(x*0.37,2), date('2024-01-01', '+'||(x%900)||' days'), 'free text note number '||(x*31%9973)||' for row '||x FROM s;
COMMIT;
SQL
} | sqlite3 "$DB" >/dev/null
echo "fixture: $DB ($(du -h "$DB" | cut -f1))"
