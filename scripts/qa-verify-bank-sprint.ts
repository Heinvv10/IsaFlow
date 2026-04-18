/**
 * End-to-end verification of the bank-import sprint changes:
 *
 *   1. Role matrix — manager is blocked from COA/bank-account writes,
 *      owner is allowed.
 *   2. Universal delete balance check — blocked when balance ≠ 0,
 *      allowed when balance = 0, applies to any GL account.
 *   3. Bank statement import security gate — PDF mismatch → 403,
 *      PDF match → 2xx.
 *
 * Talks to the real dev server on localhost:3200 and the demo DB
 * directly for setup/teardown.
 */
import { createSql } from './_pg';
import * as fs from 'node:fs';
import * as path from 'node:path';

const envPath = '/home/hein/Workspace/IsaFlow/.env.local';
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  if (!process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}

const BASE = 'http://localhost:3200';
const BLITZ_PE = 'b5e17198-c23d-4441-a90d-68c9bc4febef';
const BRIGHTTECH_ACCOUNT = '1536f992-6e0e-421b-8770-c62a3ace67c4';
const QA_TEST_ACCOUNT = 'f1b8b750-5a38-4fff-8abc-c85d374e03fb';

interface TestResult {
  label: string;
  pass: boolean;
  detail: string;
}
const results: TestResult[] = [];

function record(label: string, pass: boolean, detail: string) {
  results.push({ label, pass, detail });
  const icon = pass ? '✅' : '❌';
  console.log(`  ${icon} ${label} — ${detail}`);
}

async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`Login failed for ${email}: ${r.status}`);
  return (r.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
}

async function api(cookie: string, method: string, url: string, body?: unknown) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let parsed: unknown = txt;
  try { parsed = JSON.parse(txt); } catch {}
  return { status: r.status, body: parsed, raw: txt };
}

async function main() {
  const sql = createSql();
  await sql`UPDATE gl_accounts SET is_active = true WHERE id = ${BRIGHTTECH_ACCOUNT}`;

  // ── Group 1: Role matrix enforcement ───────────────────────────────────────
  console.log('\n=== Group 1: Role matrix (owner/admin vs manager) ===');
  const managerCookie = await login('fabri-manager-01@isaflow.test', 'QaOnboard!2026');
  const ownerCookie = await login('qa-onboard-05@isaflow.test', 'QaOnboard!2026');

  // 1a: manager PUT /bank-accounts — expect 403
  const r1a = await api(managerCookie, 'PUT', '/api/accounting/bank-accounts', {
    id: BRIGHTTECH_ACCOUNT,
    bankName: 'HACKED-BY-MANAGER',
  });
  record(
    'manager PUT /bank-accounts → 403',
    r1a.status === 403,
    `got ${r1a.status} ${(r1a.body as { error?: { message?: string } })?.error?.message ?? ''}`,
  );

  // 1b: manager POST /chart-of-accounts — expect 403
  const r1b = await api(managerCookie, 'POST', '/api/accounting/chart-of-accounts', {
    accountCode: 'QA-999',
    accountName: 'Manager-created account',
    accountType: 'expense',
    normalBalance: 'debit',
  });
  record(
    'manager POST /chart-of-accounts → 403',
    r1b.status === 403,
    `got ${r1b.status} ${(r1b.body as { error?: { message?: string } })?.error?.message ?? ''}`,
  );

  // 1c: manager DELETE /chart-of-accounts-detail — expect 403
  const r1c = await api(managerCookie, 'DELETE', `/api/accounting/chart-of-accounts-detail?id=${BRIGHTTECH_ACCOUNT}`);
  record(
    'manager DELETE /chart-of-accounts-detail → 403',
    r1c.status === 403,
    `got ${r1c.status} ${(r1c.body as { error?: { message?: string } })?.error?.message ?? ''}`,
  );

  // 1d: owner PUT /bank-accounts — expect 200
  const r1d = await api(ownerCookie, 'PUT', '/api/accounting/bank-accounts', {
    id: BRIGHTTECH_ACCOUNT,
    bankName: 'ABSA',
  });
  record(
    'owner PUT /bank-accounts → 200',
    r1d.status === 200,
    `got ${r1d.status}`,
  );

  // ── Group 2: Delete balance check (universal, any GL account) ──────────────
  console.log('\n=== Group 2: Universal delete balance check ===');

  // 2a: owner deletes Brighttech (bank, zero balance) → 200
  const r2a = await api(ownerCookie, 'DELETE', `/api/accounting/chart-of-accounts-detail?id=${BRIGHTTECH_ACCOUNT}`);
  record(
    'owner DELETE bank account (zero balance) → 200',
    r2a.status === 200,
    `got ${r2a.status}`,
  );
  // Restore
  await sql`UPDATE gl_accounts SET is_active = true WHERE id = ${BRIGHTTECH_ACCOUNT}`;

  // 2b: Seed a non-zero balance and retry → 400 with R X message
  const qaUserId = ((await sql`SELECT id FROM users WHERE email = 'qa-onboard-05@isaflow.test' LIMIT 1`) as { id: string }[])[0]!.id;
  const header = (await sql`
    INSERT INTO gl_journal_entries (company_id, entry_date, reference, description, source, status, created_by)
    VALUES (${BLITZ_PE}, '2024-01-01', 'QA-VERIFY', 'sprint verify', 'manual', 'posted', ${qaUserId})
    RETURNING id
  `) as { id: string }[];
  const headerId = header[0]!.id;

  const expenseAcc = (await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
    VALUES (${BLITZ_PE}, 'QA-EXP', 'QA Test Expense', 'expense', 'debit', true)
    ON CONFLICT (company_id, account_code) DO UPDATE SET is_active = true
    RETURNING id
  `) as { id: string }[];
  const expenseId = expenseAcc[0]!.id;

  await sql`
    INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description)
    VALUES
      (${headerId}::UUID, ${expenseId}::UUID, 500, 0, 'qa verify debit'),
      (${headerId}::UUID, ${BRIGHTTECH_ACCOUNT}::UUID, 0, 500, 'qa verify credit')
  `;

  const r2b = await api(ownerCookie, 'DELETE', `/api/accounting/chart-of-accounts-detail?id=${BRIGHTTECH_ACCOUNT}`);
  const r2bMsg = (r2b.body as { error?: { message?: string } })?.error?.message ?? '';
  record(
    'owner DELETE bank account (-500 balance) → 400 with R amount',
    r2b.status === 400 && /balance/i.test(r2bMsg) && /500/.test(r2bMsg),
    `got ${r2b.status} "${r2bMsg.slice(0, 80)}"`,
  );

  // 2c: Same check on a non-bank account (expense). Seed a balance, retry delete.
  const r2c = await api(ownerCookie, 'DELETE', `/api/accounting/chart-of-accounts-detail?id=${expenseId}`);
  const r2cMsg = (r2c.body as { error?: { message?: string } })?.error?.message ?? '';
  record(
    'owner DELETE non-bank account (500 balance) → 400 with R amount',
    r2c.status === 400 && /balance/i.test(r2cMsg) && /500/.test(r2cMsg),
    `got ${r2c.status} "${r2cMsg.slice(0, 80)}"`,
  );

  // Cleanup
  await sql`DELETE FROM gl_journal_lines WHERE journal_entry_id = ${headerId}::UUID`;
  await sql`DELETE FROM gl_journal_entries WHERE id = ${headerId}::UUID`;
  await sql`UPDATE gl_accounts SET is_active = false WHERE id = ${expenseId}::UUID`;
  await sql`UPDATE gl_accounts SET is_active = true WHERE id = ${BRIGHTTECH_ACCOUNT}`;

  // ── Group 3: Bank statement import security gate ───────────────────────────
  console.log('\n=== Group 3: Bank statement import security gate ===');
  const pdfBase64 = fs.readFileSync(
    path.resolve('/home/hein/Workspace/IsaFlow/test-docs/bank-statements/stmt_196.pdf'),
  ).toString('base64');

  // 3a: owner imports Brighttech PDF into WRONG account → 403
  const r3a = await api(ownerCookie, 'POST', '/api/accounting/bank-transactions-import', {
    pdfBase64,
    bankAccountId: QA_TEST_ACCOUNT,
    statementDate: '2024-01-29',
    fileType: 'pdf',
  });
  record(
    'owner imports PDF into wrong account → 403',
    r3a.status === 403,
    `got ${r3a.status}`,
  );

  // 3b: owner imports same PDF into RIGHT account → 201
  const r3b = await api(ownerCookie, 'POST', '/api/accounting/bank-transactions-import', {
    pdfBase64,
    bankAccountId: BRIGHTTECH_ACCOUNT,
    statementDate: '2024-01-29',
    fileType: 'pdf',
  });
  record(
    'owner imports PDF into matching account → 201',
    r3b.status === 201,
    `got ${r3b.status}`,
  );

  // 3c: manager tries the same (matching) import — operational, should work
  const r3c = await api(managerCookie, 'POST', '/api/accounting/bank-transactions-import', {
    pdfBase64,
    bankAccountId: BRIGHTTECH_ACCOUNT,
    statementDate: '2024-01-29',
    fileType: 'pdf',
  });
  record(
    'manager imports PDF into matching account → 201 (operational, allowed)',
    r3c.status === 201,
    `got ${r3c.status}`,
  );

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n=== Summary ===');
  const passCount = results.filter(r => r.pass).length;
  const totalCount = results.length;
  console.log(`  ${passCount}/${totalCount} assertions passed`);
  if (passCount < totalCount) {
    console.log('\nFailures:');
    results.filter(r => !r.pass).forEach(r => console.log(`  ❌ ${r.label} — ${r.detail}`));
  }
  process.exit(passCount === totalCount ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
