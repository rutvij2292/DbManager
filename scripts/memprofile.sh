#!/usr/bin/env bash
# Memory profile of Tabnix: physical footprint (what Activity Monitor shows) of the main process plus the
# WebKit helper processes it spawned, for a fixed set of scenarios against a deterministic SQLite fixture.
#
#   scripts/memprofile.sh                 build a profile binary, run all scenarios, print a table
#   scripts/memprofile.sh --update        also store the result as bench/mem-baseline.json
#   scripts/memprofile.sh --check         compare against the baseline; exit 1 on a regression
#   scripts/memprofile.sh --no-build ...  reuse the last profile binary
#   scripts/memprofile.sh large tabs20    run only the named scenarios
#
# Scenarios (ui/src/profile.ts): cold, connected, large_view (200k rows, first screen only), large (200k rows,
# first 12k scrolled through page by page), tabs20, after_close.
# Env: SETTLE=8 (seconds to idle after a scenario is ready), BUDGET_PCT=10, BUDGET_MB=15.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

CHECK=0; UPDATE=0; BUILD=1; WANT=()
for a in "$@"; do case "$a" in
  --check) CHECK=1 ;; --update) UPDATE=1 ;; --no-build) BUILD=0 ;;
  -*) echo "unknown option $a" >&2; exit 2 ;; *) WANT+=("$a") ;;
esac; done
ALL=(cold connected large_view large huge inspect find replace tabs20 wide10 after_close)
[ ${#WANT[@]} -eq 0 ] && WANT=("${ALL[@]}")
SETTLE="${SETTLE:-8}"
OUT=bench/mem-latest.json
APP=target/profile/release/bundle/macos/Tabnix.app
BIN=$APP/Contents/MacOS/tabnix

if [ "$BUILD" = 1 ]; then
  (cd ui && npm install --silent)
  # Release profile like the shipped app, plus the `profile` feature and a UI built with VITE_PROFILE=1.
  # A separate target dir keeps this build from touching the real release artifacts.
  CARGO_TARGET_DIR="$PWD/target/profile" VITE_PROFILE=1 ./ui/node_modules/.bin/tauri build --bundles app --features profile >/dev/null
fi
[ -x "$BIN" ] || { echo "missing $BIN (run without --no-build)" >&2; exit 1; }
scripts/memfixture.sh
DB="$PWD/bench/mem.db"

webkit_pids() { pgrep -f "com\.apple\.WebKit\.(WebContent|GPU|Networking)" | sort -n || true; }
# phys_footprint of one pid, in bytes (0 when it has exited)
fp() { footprint -p "$1" --noCategories -f bytes 2>/dev/null | awk '/phys_footprint:/ {print $2; f=1} END {if(!f) print 0}'; }

mkdir -p bench
echo '{}' > "$OUT.tmp"
printf '%-12s %9s %9s %9s %9s %6s\n' scenario main_MB webkit_MB total_MB peak_MB procs

for sc in "${WANT[@]}"; do
  before=$(webkit_pids | tr '\n' ' ')
  log=$(mktemp)
  # Launched through `open` so the app comes up in the foreground like a normal launch: a background-launched
  # app gets throttled by macOS (App Nap), which stalls the WebView's IPC and skews the numbers.
  open -n --env TABNIX_PROFILE="$sc" --env TABNIX_PROFILE_DB="$DB" --stdout "$log" --stderr "$log" "$APP"
  app=""
  for _ in $(seq 1 40); do app=$(pgrep -f "^$PWD/$BIN" | head -1 || true); [ -n "$app" ] && break; sleep 0.25; done
  [ -n "$app" ] || { echo "$sc: app did not start"; exit 1; }
  ok=0
  for _ in $(seq 1 600); do
    grep -q '^READY ' "$log" && { ok=1; break; }
    kill -0 "$app" 2>/dev/null || break
    sleep 0.5
  done
  if [ "$ok" != 1 ]; then echo "$sc: did not become ready"; tail -5 "$log"; kill "$app" 2>/dev/null || true; rm -f "$log"; exit 1; fi
  if grep -q 'FAILED' "$log"; then echo "$sc: $(grep FAILED "$log")"; kill "$app" 2>/dev/null || true; rm -f "$log"; exit 1; fi
  sleep "$SETTLE"
  # Helpers that appeared after launch are ours (they are re-parented to launchd, so the process tree cannot tell).
  mine=()
  for p in $(webkit_pids); do case " $before " in *" $p "*) ;; *) mine+=("$p") ;; esac; done
  main=$(fp "$app"); web=0
  for p in "${mine[@]}"; do web=$((web + $(fp "$p"))); done
  peak=$(footprint -p "$app" --noCategories -f bytes 2>/dev/null | awk '/phys_footprint_peak:/ {print $2}')
  python3 -I - "$OUT.tmp" "$sc" "$main" "$web" "${peak:-0}" "${#mine[@]}" <<'PY'
import json, sys
path, sc, main, web, peak, n = sys.argv[1:]
d = json.load(open(path)); MB = 1024 * 1024
d[sc] = {"main_mb": round(int(main) / MB, 1), "webkit_mb": round(int(web) / MB, 1), "total_mb": round((int(main) + int(web)) / MB, 1), "main_peak_mb": round(int(peak) / MB, 1), "webkit_procs": int(n)}
json.dump(d, open(path, "w"), indent=1)
r = d[sc]
print(f"{sc:<12} {r['main_mb']:>9} {r['webkit_mb']:>9} {r['total_mb']:>9} {r['main_peak_mb']:>9} {r['webkit_procs']:>6}")
if r["webkit_procs"] != 3: print(f"  warning: expected 3 WebKit helpers, found {r['webkit_procs']} (other WebKit apps starting/quitting?)")
PY
  kill "$app" 2>/dev/null || true; sleep 1
  rm -f "$log"
done
mv "$OUT.tmp" "$OUT"

if [ "$UPDATE" = 1 ]; then cp "$OUT" bench/mem-baseline.json; echo "baseline updated: bench/mem-baseline.json"; fi
if [ "$CHECK" = 1 ]; then
  [ -f bench/mem-baseline.json ] || { echo "no baseline; run with --update first" >&2; exit 2; }
  python3 -I - bench/mem-baseline.json "$OUT" "${BUDGET_PCT:-10}" "${BUDGET_MB:-15}" <<'PY'
import json, sys
base, cur = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
pct, mb = float(sys.argv[3]), float(sys.argv[4]); bad = 0
for sc, r in cur.items():
    if sc not in base: continue
    b, c = base[sc]["total_mb"], r["total_mb"]
    if c > b * (1 + pct / 100) and c - b > mb:
        print(f"REGRESSION {sc}: {b} -> {c} MB (+{c - b:.1f} MB)"); bad = 1
print("memory budget: FAIL" if bad else "memory budget: ok")
sys.exit(bad)
PY
fi
