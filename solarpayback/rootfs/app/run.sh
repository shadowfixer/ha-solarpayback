#!/bin/sh
# HA SolarPayBack Add-on — Entrypoint
# Starts the FastAPI server on port 8099 (ingress_port)

set -e

# Ensure data directory exists (owned by intended runtime user)
mkdir -p /data
chmod 777 /data 2>/dev/null || true

# Database path (persistent)
export DB_PATH="/data/ha-solarpayback.db"

# Supervisor token path (injected by HA when homeassistant_api: true)
export SUPERVISOR_TOKEN_PATH="/var/run/secrets/hassio-token"

# HA Supervisor API base (internal)
export SUPERVISOR_API="http://supervisor"

# Log startup info
echo "=== HA SolarPayBack Add-on Starting ==="
echo "Database: $DB_PATH"
echo "Supervisor token: $SUPERVISOR_TOKEN_PATH"
echo "Ingress port: 8099"

# Wait for supervisor token to be available (HA injects it after container start)
# This can take a few seconds on first boot
for i in $(seq 1 30); do
    if [ -f "$SUPERVISOR_TOKEN_PATH" ]; then
        echo "Supervisor token found"
        break
    fi
    echo "Waiting for supervisor token... ($i/30)"
    sleep 1
done

if [ ! -f "$SUPERVISOR_TOKEN_PATH" ]; then
    echo "WARNING: Supervisor token not found at $SUPERVISOR_TOKEN_PATH"
    echo "HA API calls will fail. Check homeassistant_api: true in config.yaml"
fi

# Start the FastAPI application with uvicorn (from the venv)
exec /venv/bin/python -m uvicorn main:app \
    --host 0.0.0.0 \
    --port 8099 \
    --log-level info \
    --access-log