#!/bin/sh
set -e

echo "Running data migrations (idempotent, safe to rerun)..."
node drizzle/migrate-workspace-statuses.mjs
node drizzle/migrate-workspace-custom-fields.mjs

echo "Syncing schema..."
npx drizzle-kit push --force
echo "Migrations complete."

echo "Starting server..."
exec node dist/index.js
