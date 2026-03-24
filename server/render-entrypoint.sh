#!/bin/sh
set -eu

CONFIG_PATH="/nakama/data/render.yml"
cp /nakama/data/local.yml "$CONFIG_PATH"

# Render-managed Postgres details.
DB_HOST="${DB_HOST:-}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-nakama}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_NAME="${DB_NAME:-nakama}"

if [ -n "$DB_HOST" ]; then
  sed -i "s|^[[:space:]]*-[[:space:]]*postgres:5432|  - ${DB_HOST}:${DB_PORT}|" "$CONFIG_PATH"
fi
# Match indented keys under `database:` only (avoid `^database:` which would break the YAML map).
sed -i "s|^[[:space:]]*username: nakama|  username: ${DB_USER}|" "$CONFIG_PATH"
sed -i "s|^[[:space:]]*password: localdev|  password: ${DB_PASSWORD}|" "$CONFIG_PATH"
sed -i "s|^[[:space:]]*database: nakama|  database: ${DB_NAME}|" "$CONFIG_PATH"

# Use a production server key from Render env vars.
SERVER_KEY="${NAKAMA_SERVER_KEY:-defaultkey}"
sed -i "s|^  server_key:.*|  server_key: ${SERVER_KEY}|" "$CONFIG_PATH"

# Render injects a required listening port.
if [ -n "${PORT:-}" ]; then
  sed -i "/^socket:/a\\  port: ${PORT}" "$CONFIG_PATH"
fi

/nakama/nakama migrate up --config "$CONFIG_PATH"
exec /nakama/nakama --config "$CONFIG_PATH"
