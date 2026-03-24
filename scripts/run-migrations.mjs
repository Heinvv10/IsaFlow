import pg from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_TDuKN9ao1sZB@ep-shiny-flower-aldyej0o-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require';

const client = new pg.Client({ connectionString: DATABASE_URL });

const migrations = [
  '000_users_and_auth.sql',
  '200_accounting_foundation.sql',
  '201_accounts_payable.sql',
  '202_accounts_receivable.sql',
  '203_bank_reconciliation.sql',
  '204_financial_reporting.sql',
  '205_sage_migration.sql',
  '206_phase1_sage_alignment.sql',
  '210_vat201_data_model.sql',
];

async function runMigrations() {
  console.log('=== Accounting Database Migration ===\n');

  await client.connect();
  console.log('Connected to database.\n');

  for (const migration of migrations) {
    const filePath = join(process.cwd(), 'scripts/migrations/sql', migration);
    try {
      const sqlContent = readFileSync(filePath, 'utf-8');
      console.log(`Running: ${migration}`);
      await client.query(sqlContent);
      console.log(`  ✓ Done\n`);
    } catch (error) {
      console.error(`  ✗ Failed: ${error.message}\n`);
    }
  }

  // Seed admin user
  console.log('Seeding admin user...');
  try {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('admin123', 12);
    await client.query(`
      INSERT INTO users (id, email, password_hash, first_name, last_name, role, permissions, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8)
      ON CONFLICT (email) DO NOTHING
    `, ['admin-001', 'admin@accounting.local', hash, 'Admin', 'User', 'super_admin', '["*"]', true]);
    console.log('  ✓ Admin user seeded (admin@accounting.local / admin123)\n');
  } catch (error) {
    console.error(`  ✗ Seed failed: ${error.message}\n`);
  }

  // Verify
  console.log('Verifying tables...');
  const result = await client.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  console.log(`  Found ${result.rows.length} tables:`);
  result.rows.forEach(t => console.log(`    - ${t.tablename}`));

  await client.end();
  console.log('\n=== Migration complete ===');
}

runMigrations().catch(err => {
  console.error('Fatal error:', err);
  client.end();
  process.exit(1);
});
