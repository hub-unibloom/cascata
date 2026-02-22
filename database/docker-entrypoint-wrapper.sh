#!/bin/bash
set -e

# Start the Phantom Linker in the background
echo "[Cascata] Starting Phantom Extension Linker..."
/usr/local/bin/phantom_linker &

# Execute the standard Official PostgreSQL entrypoint
echo "[Cascata] Starting PostgreSQL Core..."
exec docker-entrypoint.sh "$@"
