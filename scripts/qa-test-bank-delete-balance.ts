/**
 * Integration test for the bank-account delete guard.
 *
 * Scenarios:
 *   1. Delete the Brighttech bank account with GL balance = 0 and no
 *      unreconciled transactions → should succeed (204 / soft delete).
 *   2. Seed a journal line that puts the account into a non-zero
 *      balance, then try again → should be blocked with a clear
 *      "balance is R X" error.
 *   3. Clean up (restore is_active + remove the test journal line).
 *
 * Runs directly against the demo DB via neon + the dev-server API so
 * we exercise the full middleware + service code path.
 */
import { neon } from '@neondatabase/serverless';
import * as fs from 'node:fs';

const envPath = '/home/hein/Workspace/IsaFlow/.env.local';
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  if (!process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}

const BASE = 'http://localhost:3200';
const BLITZ_PE = 'b5e17198-c23d-4441-a90d-68c9bc4febef';
const BRIGHTTECH_ACCOUNT = '1536f992-6e0e-421b-8770-c62a3ace67c4'; // Brighttech ABSA 4069625895

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'qa-onboard-05@isaflow.test', password: 'QaOnboard!2026' }),
  });
  if (!r.ok) throw new Error(`Login failed: ${r.status}`);
  const cookies = r.headers.getSetCookie?.() ?? [];
  return cookies.map(c => c.split(';')[0]).join('; ');
}

async function tryDelete(cookie: string, id: string) {
  const r = await fetch(`${BASE}/api/accounting/chart-of-accounts-detail?id=${id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  const bodyText = await r.text();
  let body: unknown = bodyText;
  try { body = JSON.parse(bodyText); } catch {}
  return { status: r.status, body };
}

async function restoreAccount(sql: ReturnType<typeof neon>) {
  await sql`UPDATE gl_accounts SET is_active = true WHERE id = ${BRIGHTTECH_ACCOUNT}`;
}

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const cookie = await login();
  console.log('✓ Logged in as qa-onboard-05');

  // Make sure the account is active + balance is zero at the start.
  await restoreAccount(sql);

  // Scenario 1: delete with balance = 0 → should succeed.
  console.log('\n=== Scenario 1: delete with zero balance — expect 200 ===');
  const s1 = await tryDelete(cookie, BRIGHTTECH_ACCOUNT);
  console.log(`  HTTP ${s1.status}`);
  console.log(`  body: ${JSON.stringify(s1.body).slice(0, 200)}`);

  // Restore the account for Scenario 2 (re-activate it).
  await restoreAccount(sql);
  console.log('  (account restored to is_active=true)');

  // Scenario 2: inject a journal line that makes balance non-zero,
  // then try to delete.
  console.log('\n=== Scenario 2: delete with non-zero balance — expect 400/403 with R X message ===');

  // Look up the qa-onboard-05 user ID so created_by is a real UUID.
  const userRows = (await sql`
    SELECT id FROM users WHERE email = 'qa-onboard-05@isaflow.test' LIMIT 1
  `) as { id: string }[];
  const qaUserId = userRows[0]!.id;

  // Need a journal header first.
  const header = (await sql`
    INSERT INTO gl_journal_entries (
      company_id, entry_date, reference, description, source, status, created_by
    ) VALUES (
      ${BLITZ_PE}, '2024-01-01', 'QA-DEL-TEST', 'QA delete balance test', 'manual', 'posted', ${qaUserId}
    )
    RETURNING id
  `) as { id: string }[];
  const headerId = header[0]!.id;

  // Need a balancing account — create a temp expense account.
  const expenseAcc = (await sql`
    INSERT INTO gl_accounts (
      company_id, account_code, account_name,
      account_type, normal_balance, is_active
    ) VALUES (
      ${BLITZ_PE}, 'QA-EXP', 'QA Test Expense', 'expense', 'debit', true
    )
    ON CONFLICT (company_id, account_code) DO UPDATE SET is_active = true
    RETURNING id
  `) as { id: string }[];
  const expenseAccountId = expenseAcc[0]!.id;

  // Post: DR expense 500, CR bank 500
  await sql`
    INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description)
    VALUES
      (${headerId}::UUID, ${expenseAccountId}::UUID, 500, 0, 'QA test debit'),
      (${headerId}::UUID, ${BRIGHTTECH_ACCOUNT}::UUID, 0, 500, 'QA test credit')
  `;
  console.log('  (seeded -500 credit line on bank account)');

  const s2 = await tryDelete(cookie, BRIGHTTECH_ACCOUNT);
  console.log(`  HTTP ${s2.status}`);
  console.log(`  body: ${JSON.stringify(s2.body).slice(0, 300)}`);

  // Clean up: remove the test journal entry
  await sql`DELETE FROM gl_journal_lines WHERE journal_entry_id = ${headerId}::UUID`;
  await sql`DELETE FROM gl_journal_entries WHERE id = ${headerId}::UUID`;
  await sql`UPDATE gl_accounts SET is_active = false WHERE id = ${expenseAccountId}::UUID`;
  await restoreAccount(sql);
  console.log('  (test data cleaned up)');

  console.log('\n=== Summary ===');
  const s1_ok = s1.status === 200;
  const s2_ok = s2.status >= 400 && s2.status < 500
    && JSON.stringify(s2.body).toLowerCase().includes('balance');
  console.log(`  Scenario 1 (zero balance → 200):       ${s1_ok ? '✅ PASS' : '❌ FAIL (got ' + s1.status + ')'}`);
  console.log(`  Scenario 2 (non-zero → 4xx balance): ${s2_ok ? '✅ PASS' : '❌ FAIL'}`);

  process.exit(s1_ok && s2_ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
