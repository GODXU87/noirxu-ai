#!/bin/sh
# Starts a throwaway local PostgreSQL with the production noirxu_ai layout for
# integration tests:  sh scripts/test-db.sh [extra-migration.sql ...]
# Then:  NOIRXU_TEST_DATABASE_URL=postgresql://noirxu_ai_app:test-only-password@127.0.0.1:55432/noirxu_test npm test
set -e
PG=${PG_BIN:-/usr/lib/postgresql/16/bin}
DIR=${PG_TEST_DIR:-/var/lib/postgresql/noirxu-test}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
run() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else sh -c "$*"; fi; }
run "$PG/pg_ctl -D $DIR stop -m fast" >/dev/null 2>&1 || true
PWFILE=$(mktemp); echo local-admin > "$PWFILE"; chmod 644 "$PWFILE"
run "rm -rf $DIR && $PG/initdb -D $DIR -A scram-sha-256 --pwfile=$PWFILE -U postgres -E UTF8" >/dev/null
rm -f "$PWFILE"
run "$PG/pg_ctl -D $DIR -o '-p 55432 -k /tmp -c listen_addresses=127.0.0.1' -l $DIR.log -w start" >/dev/null
export PGPASSWORD=local-admin
psql -h 127.0.0.1 -p 55432 -U postgres -q -c "create database noirxu_test"
psql -h 127.0.0.1 -p 55432 -U postgres -d noirxu_test -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/test/baseline-noirxu-ai.sql"
for f in "$@"; do psql -h 127.0.0.1 -p 55432 -U postgres -d noirxu_test -q -v ON_ERROR_STOP=1 -f "$f"; echo "applied $f"; done
echo "ready: postgresql://noirxu_ai_app:test-only-password@127.0.0.1:55432/noirxu_test"
