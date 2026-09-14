#!/bin/sh
# Applies each numbered migration exactly once, in order, and records it in schema_migrations.
#
# The migrate service used to replay every file on every `docker compose up`. That only works while
# every migration is safe to repeat forever, and 0002's backfill is not: it fills a NULL
# collection_id with 'general' and re-imposes NOT NULL. Once a policy may legitimately wait for its
# collection (0008), a replay would file every such policy under 'general', or fail and keep the
# stack from starting. A ledger is the standard answer: each file runs once, in one transaction
# together with the row that records it, so a failed migration leaves neither schema nor record.
#
# Connection comes from the standard libpq variables: PGHOST, PGPORT, PGDATABASE, PGUSER,
# PGPASSWORD. Usage: migrate.sh [directory], default /migrations.
set -eu

dir="${1:-/migrations}"
# The idempotent DDL in older files still emits "already exists, skipping" notices; they are noise.
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

psql -v ON_ERROR_STOP=1 -q -c "create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
)"

applied=0
skipped=0
for file in "$dir"/0*.sql; do
  [ -e "$file" ] || continue
  name=$(basename "$file")
  # The name is inlined into SQL below, so it must be a plain migration file name.
  case "$name" in
    *[!a-z0-9_.]*)
      echo "Refusing migration with an unexpected file name: $name" >&2
      exit 1
      ;;
  esac
  if [ -n "$(psql -tA -c "select 1 from schema_migrations where name = '$name'")" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  {
    cat "$file"
    printf "\ninsert into schema_migrations (name) values ('%s');\n" "$name"
  } | psql -v ON_ERROR_STOP=1 -q --single-transaction -f -
  echo "applied $name"
  applied=$((applied + 1))
done

echo "migrations: $applied applied, $skipped already recorded"
