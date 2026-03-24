#!/bin/bash
# Accounting App - Database Setup
# Runs all migrations in order against the Neon database

set -e

# Load .env.local if it exists
if [ -f .env.local ]; then
  export $(grep -v '^#' .env.local | xargs)
fi

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set"
  exit 1
fi

echo "=== Accounting Database Setup ==="
echo ""

MIGRATIONS_DIR="scripts/migrations/sql"

# Run migrations in order
for migration in \
  000_users_and_auth.sql \
  200_accounting_foundation.sql \
  201_accounts_payable.sql \
  202_accounts_receivable.sql \
  203_bank_reconciliation.sql \
  204_financial_reporting.sql \
  205_sage_migration.sql \
  210_vat201_data_model.sql; do

  if [ -f "$MIGRATIONS_DIR/$migration" ]; then
    echo "Running: $migration"
    psql "$DATABASE_URL" -f "$MIGRATIONS_DIR/$migration" 2>&1 | tail -5
    echo "  ✓ Done"
    echo ""
  else
    echo "  ⚠ Skipping $migration (not found)"
  fi
done

echo "=== All migrations complete ==="
echo ""

# Seed admin user
echo "Seeding admin user..."
psql "$DATABASE_URL" -c "
INSERT INTO users (id, email, password_hash, first_name, last_name, role, permissions, is_active)
VALUES (
  'admin-001',
  'admin@accounting.local',
  -- bcrypt hash of 'admin123' (change in production!)
  '\$2b\$12\$uabVX3TLtKt5yMdFm3GioObqpAk43vXvClYnjc9nEm8ISKRMD1jSG',
  'Admin',
  'User',
  'super_admin',
  '[\"*\"]'::JSONB,
  true
)
ON CONFLICT (email) DO NOTHING;
"
echo "  ✓ Admin user seeded"

echo ""
echo "=== Setup complete ==="
