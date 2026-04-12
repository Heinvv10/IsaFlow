/**
 * Check the state of the current DATABASE_URL target.
 * Tells us if we're staring at a clean/empty Neon branch or a populated one.
 */
import { neon } from '@neondatabase/serverless';
import * as fs from 'node:fs';
import * as path from 'node:path';

const envPath = path.resolve(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    if (!process.env[k!]) process.env[k!] = rawV!.replace(/^["']|["']$/g, '');
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL required');
  process.exit(1);
}

// Redact credentials when echoing the target.
const redacted = DATABASE_URL.replace(/\/\/[^@]+@/, '//*****@');
console.log(`Target: ${redacted}`);

const sql = neon(DATABASE_URL);

async function main() {
  // Ask Postgres about tables in public.
  const tables = (await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `) as Array<{ table_name: string }>;
  console.log(`\nTables in public schema: ${tables.length}`);
  if (tables.length === 0) {
    console.log('  (empty — needs migrations)');
    return;
  }

  // Row counts for a few key tables.
  const keyTables = ['users', 'companies', 'company_users', 'gl_accounts', 'migrations'];
  console.log('\nKey table row counts:');
  for (const t of keyTables) {
    if (!tables.find(tt => tt.table_name === t)) {
      console.log(`  ${t.padEnd(20)} NOT PRESENT`);
      continue;
    }
    try {
      const rows = (await sql.query(`SELECT COUNT(*)::int AS count FROM "${t}"`)) as Array<{
        count: number;
      }>;
      console.log(`  ${t.padEnd(20)} ${rows[0]?.count ?? 0}`);
    } catch (err) {
      console.log(`  ${t.padEnd(20)} ERROR: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  // If migrations table exists, show last few.
  if (tables.find(t => t.table_name === 'migrations')) {
    const recent = (await sql`
      SELECT id, name, executed_at FROM migrations ORDER BY id DESC LIMIT 5
    `) as Array<{ id: number; name: string; executed_at: string }>;
    console.log('\nMost recent migrations:');
    recent.forEach(m => console.log(`  ${m.id}  ${m.name}  (${m.executed_at})`));
  }

  // Probe for columns added by recent migrations so we can detect drift.
  console.log('\nRecent migration probes:');
  const probes: Array<[string, string, string, number]> = [
    // [label, table, column, migration_id]
    ['users.must_change_password',                    'users',                'must_change_password', 289],
    ['companies.org_no_of_employees',                 'companies',            'no_of_employees',       286],
    ['bank_rules.applies_to_transaction_types',       'bank_rules',           'applies_to_transaction_types', 284],
    ['sars_submissions.company_id',                   'sars_submissions',     'company_id',            291],
    ['page_visits (table)',                           'page_visits',          null as unknown as string, 287],
  ];
  for (const [label, table, column, mig] of probes) {
    try {
      if (column === null) {
        const t = (await sql.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
          [table],
        )) as unknown[];
        console.log(`  ${label.padEnd(45)} m${mig} ${t.length > 0 ? '✓' : '✗ missing'}`);
      } else {
        const c = (await sql.query(
          `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
          [table, column],
        )) as unknown[];
        console.log(`  ${label.padEnd(45)} m${mig} ${c.length > 0 ? '✓' : '✗ missing'}`);
      }
    } catch (err) {
      console.log(`  ${label.padEnd(45)} m${mig} ERROR: ${(err as Error).message.slice(0, 60)}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
