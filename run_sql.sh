#!/bin/sh
set -eu

RUN_SQL_DATABASE_URL="${RUN_SQL_DATABASE_URL:-${DATABASE_URL:-}}"

if [ -z "$RUN_SQL_DATABASE_URL" ]; then
	echo "Missing RUN_SQL_DATABASE_URL or DATABASE_URL environment variable." >&2
	exit 1
fi

psql "$RUN_SQL_DATABASE_URL" -f /tmp/rename_table.sql
