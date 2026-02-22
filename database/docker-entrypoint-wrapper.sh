#!/bin/bash
set -e

# Start the Phantom Linker in the background
echo "[Cascata] Starting Phantom Extension Linker..."
/usr/local/bin/phantom_linker &

# Execute the standard Official PostgreSQL entrypoint with preloaded extensions
echo "[Cascata] Starting PostgreSQL Core with pg_cron and pg_stat_statements preloaded..."
exec docker-entrypoint.sh "$@" -c shared_preload_libraries="pg_cron,pg_stat_statements"
