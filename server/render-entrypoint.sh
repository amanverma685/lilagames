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

# Nakama reads credentials from database.address only (form: user:pass@host:port/dbname).
# A bare host:port defaults to user "root" and DB "nakama" — wrong for Render Postgres.
if [ -n "$DB_HOST" ]; then
  DB_SSLMODE="${DB_SSLMODE:-require}"
  # Minimal URL-encoding for userinfo (order: % first). Render passwords are usually safe.
  enc() {
    printf '%s' "$1" | sed \
      -e 's/%/%25/g' \
      -e 's/@/%40/g' \
      -e 's/:/%3A/g' \
      -e 's/#/%23/g' \
      -e 's|/|%2F|g' \
      -e 's/?/%3F/g'
  }
  EU=$(enc "$DB_USER")
  EP=$(enc "$DB_PASSWORD")
  DSN="${EU}:${EP}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=${DB_SSLMODE}"
  sed -i "s|^[[:space:]]*-[[:space:]]*postgres:5432|    - \"${DSN}\"|" "$CONFIG_PATH"
fi
# Keep YAML in sync for humans / older tooling (Nakama uses address DSN above).
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
