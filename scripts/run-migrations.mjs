import pg from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });

async function runMigrations() {
  console.log('=== Accounting Database Migration ===\n');

  await client.connect();
  console.log('Connected to database.\n');

  // Create migration tracking table
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Get already-applied migrations
  const applied = await client.query('SELECT filename FROM schema_migrations ORDER BY filename');
  const appliedSet = new Set(applied.rows.map(r => r.filename));

  // Discover all migration files in order
  const migrationsDir = join(process.cwd(), 'scripts/migrations/sql');
  const allFiles = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let newCount = 0;

  for (const migration of allFiles) {
    if (appliedSet.has(migration)) {
      continue; // Already applied
    }

    const filePath = join(migrationsDir, migration);
    try {
      const sqlContent = readFileSync(filePath, 'utf-8');
      console.log(`Running: ${migration}`);
      await client.query(sqlContent);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [migration]);
      console.log(`  ✓ Done\n`);
      newCount++;
    } catch (error) {
      console.error(`  ✗ Failed: ${error.message}\n`);
      // Fail fast on migration errors — don't leave schema in partial state
      console.error(`ABORTING: Fix the migration and re-run.`);
      await client.end();
      process.exit(1);
    }
  }

  if (newCount === 0) {
    console.log('All migrations already applied.\n');
  } else {
    console.log(`Applied ${newCount} new migration(s).\n`);
  }

  // Seed admin user if not exists
  console.log('Seeding admin user...');
  try {
    const bcrypt = await import('bcryptjs');
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) throw new Error('ADMIN_PASSWORD environment variable is required');
    const hash = await bcrypt.hash(adminPassword, 12);
    await client.query(`
      INSERT INTO users (id, email, password_hash, first_name, last_name, role, permissions, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8)
      ON CONFLICT (email) DO NOTHING
    `, ['admin-001', 'admin@accounting.local', hash, 'Admin', 'User', 'super_admin', '["*"]', true]);
    console.log('  ✓ Admin user seeded\n');
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
