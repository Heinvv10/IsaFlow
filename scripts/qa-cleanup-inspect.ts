/**
 * One-shot inspector for the QA cleanup run.
 *
 * Finds every table that holds a row tied to the QA-ONBOARD test companies
 * or users so we can build an accurate CASCADE cleanup script. NON-DESTRUCTIVE.
 *
 * Usage: bun run scripts/qa-cleanup-inspect.ts
 */
import { neon } from '@neondatabase/serverless';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Manually load .env.local since we don't want a dotenv dep for one script.
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
  '6b026b16-bf78-4258-82a9-d914494caafc', // QA-ONBOARD-01 Brightsphere Technologies
  '675671c3-78f1-4b88-adb9-c888e5904069', // QA-ONBOARD-02 H10 Holdings (Pty) Ltd
];

async function main() {
  console.log('\n== Users matching test emails ==');
  const users = (await sql`
    SELECT id, email, first_name, last_name, created_at
    FROM users
    WHERE email = ANY(${TEST_EMAILS})
  `) as Array<{ id: string; email: string; first_name: string; last_name: string; created_at: string }>;
  console.table(users);
  const userIds = users.map(u => u.id);

  console.log('\n== Companies matching test IDs ==');
  const companies = (await sql`
    SELECT id, name, created_at
    FROM companies
    WHERE id = ANY(${TEST_COMPANY_IDS}::uuid[])
  `) as Array<{ id: string; name: string; created_at: string }>;
  console.table(companies);

  console.log('\n== All tables with a company_id column ==');
  const companyIdTables = (await sql`
    SELECT table_name
    FROM information_schema.columns
    WHERE column_name = 'company_id'
      AND table_schema = 'public'
    ORDER BY table_name
  `) as Array<{ table_name: string }>;
  console.log(companyIdTables.map(r => r.table_name).join('\n'));

  console.log('\n== Row counts per company_id table for the 2 test companies ==');
  for (const { table_name } of companyIdTables) {
    // Table name is from information_schema, not user input — safe to interpolate.
    // Values are still parameterised.
    try {
      const countRow = (await sql.query(
        `SELECT COUNT(*)::int AS count FROM "${table_name}" WHERE company_id = ANY($1::uuid[])`,
        [TEST_COMPANY_IDS],
      )) as Array<{ count: number }>;
      const count = countRow[0]?.count ?? 0;
      if (count > 0) console.log(`  ${table_name.padEnd(45)} ${count}`);
    } catch (err) {
      console.log(`  ${table_name.padEnd(45)} ERROR: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  console.log('\n== All tables with a user_id column ==');
  const userIdTables = (await sql`
    SELECT table_name
    FROM information_schema.columns
    WHERE column_name = 'user_id'
      AND table_schema = 'public'
    ORDER BY table_name
  `) as Array<{ table_name: string }>;
  console.log(userIdTables.map(r => r.table_name).join('\n'));

  console.log('\n== Row counts per user_id table for the 2 test users ==');
  if (userIds.length > 0) {
    for (const { table_name } of userIdTables) {
      try {
        const countRow = (await sql.query(
          `SELECT COUNT(*)::int AS count FROM "${table_name}" WHERE user_id::text = ANY($1::text[])`,
          [userIds],
        )) as Array<{ count: number }>;
        const count = countRow[0]?.count ?? 0;
        if (count > 0) console.log(`  ${table_name.padEnd(45)} ${count}`);
      } catch (err) {
        console.log(`  ${table_name.padEnd(45)} ERROR: ${(err as Error).message.slice(0, 80)}`);
      }
    }
  }

  console.log('\n✅ Inspection complete — NO rows were modified.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
