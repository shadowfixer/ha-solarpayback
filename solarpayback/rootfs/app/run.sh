#!/bin/sh
# HA SolarPayBack Add-on — Entrypoint
# Starts the FastAPI server on port 8099 (ingress_port)

set -e

# Ensure data directory exists (owned by intended runtime user)
mkdir -p /data
chmod 777 /data 2>/dev/null || true

# Database path (persistent)
export DB_PATH="/data/ha-solarpayback.db"

# HA Supervisor API base (internal)
export SUPERVISOR_API="http://supervisor"

# Log startup info
echo "=== HA SolarPayBack Add-on Starting ==="
echo "Database: $DB_PATH"
echo "Supervisor API: $SUPERVISOR_API"
echo "Ingress port: 8099"

# The Supervisor token is injected as the SUPERVISOR_TOKEN env var by HA when
# homeassistant_api: true. main.py reads it from the environment. Nothing to wait for.

# Start the FastAPI application with uvicorn (from the venv)
exec /venv/bin/python -m uvicorn main:app \
    --host 0.0.0.0 \
    --port 8099 \
    --log-level info \
    --access-log