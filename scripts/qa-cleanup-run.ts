/**
 * Destructive cleanup for the QA-ONBOARD test users and companies.
 *
 * Usage:
 *   bun run scripts/qa-cleanup-run.ts --dry-run   (default, shows what WOULD be deleted)
 *   bun run scripts/qa-cleanup-run.ts --execute   (actually deletes — requires explicit flag)
 *
 * Scope: exactly the two rows captured during the onboarding QA runs.
 *   - Users:     qa-onboard-01@isaflow.test, qa-onboard-02@isaflow.test
 *   - Companies: 6b026b16-bf78-4258-82a9-d914494caafc,
 *                675671c3-78f1-4b88-adb9-c888e5904069
 *
 * Deletion order respects FK constraints:
 *   company_documents → company_directors → page_visits →
 *   company_users → user_sessions → user_preferences →
 *   companies → users
 */
import { neon } from '@neondatabase/serverless';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Manual .env.local loader (no dotenv dep).
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

const sql = neon(DATABASE_URL);

const TEST_EMAILS = ['qa-onboard-01@isaflow.test', 'qa-onboard-02@isaflow.test'];
const TEST_COMPANY_IDS = [
  '6b026b16-bf78-4258-82a9-d914494caafc',
  '675671c3-78f1-4b88-adb9-c888e5904069',
];

const execute = process.argv.includes('--execute');
const mode = execute ? 'EXECUTE' : 'DRY RUN';

async function countByCompany(table: string): Promise<number> {
  const rows = (await sql.query(
    `SELECT COUNT(*)::int AS count FROM "${table}" WHERE company_id = ANY($1::uuid[])`,
    [TEST_COMPANY_IDS],
  )) as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

async function countByUser(table: string, userIds: string[]): Promise<number> {
  const rows = (await sql.query(
    `SELECT COUNT(*)::int AS count FROM "${table}" WHERE user_id::text = ANY($1::text[])`,
    [userIds],
  )) as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

async function deleteByCompany(table: string): Promise<number> {
  const rows = (await sql.query(
    `DELETE FROM "${table}" WHERE company_id = ANY($1::uuid[]) RETURNING 1`,
    [TEST_COMPANY_IDS],
  )) as unknown[];
  return rows.length;
}

async function deleteByUser(table: string, userIds: string[]): Promise<number> {
  const rows = (await sql.query(
    `DELETE FROM "${table}" WHERE user_id::text = ANY($1::text[]) RETURNING 1`,
    [userIds],
  )) as unknown[];
  return rows.length;
}

async function main() {
  console.log(`\n=== QA CLEANUP — ${mode} ===\n`);

  // Resolve user IDs
  const users = (await sql`
    SELECT id::text AS id, email FROM users WHERE email = ANY(${TEST_EMAILS})
  `) as Array<{ id: string; email: string }>;
  const userIds = users.map(u => u.id);
  console.log(`Users found (${users.length}):`);
  users.forEach(u => console.log(`  ${u.id}  ${u.email}`));

  const companies = (await sql`
    SELECT id::text AS id, name FROM companies WHERE id = ANY(${TEST_COMPANY_IDS}::uuid[])
  `) as Array<{ id: string; name: string }>;
  console.log(`\nCompanies found (${companies.length}):`);
  companies.forEach(c => console.log(`  ${c.id}  ${c.name}`));

  if (users.length === 0 && companies.length === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  // --- Dry run report ---
  console.log('\n--- Deletion plan ---');
  const plan: Array<[string, 'company' | 'user', number]> = [
    ['company_documents', 'company', await countByCompany('company_documents')],
    ['company_directors', 'company', await countByCompany('company_directors')],
    ['page_visits',       'company', await countByCompany('page_visits')],
    ['company_users',     'company', await countByCompany('company_users')],
    ['user_sessions',     'user',    await countByUser('user_sessions', userIds)],
    ['user_preferences',  'user',    await countByUser('user_preferences', userIds)],
  ];
  plan.forEach(([t, scope, n]) => {
    console.log(`  ${t.padEnd(22)} (${scope.padEnd(7)}) ${n}`);
  });
  console.log(`  companies              (id     ) ${companies.length}`);
  console.log(`  users                  (id     ) ${users.length}`);

  if (!execute) {
    console.log('\nDRY RUN — no rows modified.');
    console.log('Re-run with --execute to actually delete.\n');
    return;
  }

  // --- Execute ---
  console.log('\n--- Executing deletion ---');

  // Order respects FK constraints: child rows first.
  const d1 = await deleteByCompany('company_documents');
  console.log(`  company_documents      deleted ${d1}`);
  const d2 = await deleteByCompany('company_directors');
  console.log(`  company_directors      deleted ${d2}`);
  const d3 = await deleteByCompany('page_visits');
  console.log(`  page_visits (by co)    deleted ${d3}`);
  const d4 = await deleteByCompany('company_users');
  console.log(`  company_users          deleted ${d4}`);

  if (userIds.length > 0) {
    const d5 = await deleteByUser('user_sessions', userIds);
    console.log(`  user_sessions          deleted ${d5}`);
    const d6 = await deleteByUser('user_preferences', userIds);
    console.log(`  user_preferences       deleted ${d6}`);
  }

  const d7 = (await sql`
    DELETE FROM companies WHERE id = ANY(${TEST_COMPANY_IDS}::uuid[]) RETURNING id
  `) as Array<{ id: string }>;
  console.log(`  companies              deleted ${d7.length}`);

  const d8 = (await sql`
    DELETE FROM users WHERE email = ANY(${TEST_EMAILS}) RETURNING id
  `) as Array<{ id: string }>;
  console.log(`  users                  deleted ${d8.length}`);

  console.log('\n✅ Cleanup complete.\n');
}

main().catch(err => {
  console.error('\n❌ Cleanup failed:', err);
  process.exit(1);
});
