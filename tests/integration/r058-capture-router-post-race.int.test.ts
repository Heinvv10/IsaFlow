/**
 * R-058 round 4 (R-071, fixed here). `captureRouterService.routeEvent`'s
 * post-extraction status writes were themselves UNPREDICATED
 * (`WHERE id AND company_id` only). `capture_events.extracted_data`'s sibling
 * column, `captured_documents.extracted_data`, is written in an earlier,
 * separate statement — so a request lands in the ms-wide window where
 * `status = 'extracting'` (postable) WITH data already present, passes the
 * post routes' checks, and completes. `routeEvent` then finishes and its
 * unpredicated write silently reverted the event from `'posted'` back to
 * `'extracted'` — postable again — with no race needed on a SECOND call.
 * Measured before this fix: an employee expense claim went 1 → 2.
 *
 * Fix: the three writes `routeEvent` makes after extraction (`captureRouterService.ts`)
 * now carry `AND status = 'extracting'` and check their row count. A `routeEvent`
 * that loses the race to a post is a no-op on `capture_events` (logged), not a
 * silent revert.
 *
 * The rival write below intercepts the REAL `sql` call `routeEvent` makes —
 * not a replay of the statement — so this is the real interleave, same
 * technique as `k122b-portal-token-race.int.test.ts`.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';

let beforeExtractedWrite: (() => Promise<void>) | null = null;

vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    const isExtractedWrite = /UPDATE\s+capture_events/.test(text)
      && /SET\s+status\s*=\s*'extracted',/.test(text)
      && /document_category/.test(text);
    if (beforeExtractedWrite && isExtractedWrite) {
      const hook = beforeExtractedWrite;
      beforeExtractedWrite = null;
      return hook().then(() => original.sql(strings, ...values));
    }
    return original.sql(strings, ...values);
  };
  return { ...original, sql };
});
vi.mock('@/lib/documentStorage', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchRawBytes: async () => ({ buffer: Buffer.from('%PDF-race'), mimeType: 'application/pdf' }),
}));
vi.mock('@/modules/accounting/services/core/ocrService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractFromPdf: async () => EXTRACTED,
}));

import { routeEvent } from '@/modules/accounting/services/capture/captureRouterService';
import postExpense from '../../pages/api/accounting/capture/[id]/post-expense';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const employee = crypto.randomUUID();
let adminToken = '';

const EXTRACTED = {
  documentType: 'receipt',
  vendorName: 'R058d Fuel Stop',
  date: '2026-04-10',
  totalAmount: 115,
  subtotal: 100,
  vatAmount: 15,
  vatRate: 15,
  confidence: 0.95,
};

function call(eventId: string, body: unknown) {
  const req = request({ 'sb-access-token': adminToken, active_company_id: company }, 'POST') as never as {
    url: string; body: unknown; query: Record<string, string>;
  };
  req.url = '/api/accounting/capture/x';
  req.query = { id: eventId };
  req.body = body;
  const result = response();
  return postExpense(req as never, result.res).then(() => result);
}

async function claimsFor(documentId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(DISTINCT ecl.claim_id)::int AS n FROM expense_claim_lines ecl
      WHERE ecl.company_id=$1 AND ecl.source_document_id=$2`,
    [company, documentId],
  );
  return rows[0].n as number;
}

async function statusOf(eventId: string): Promise<string> {
  const { rows } = await pool.query('SELECT status FROM capture_events WHERE id=$1', [eventId]);
  return rows[0].status as string;
}

async function account(code: string, name: string, type: string, subtype: string, normal: string) {
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active,is_system_account) VALUES($1,$2,$3,$4,$5,$6,true,true)`,
    [company, code, name, type, subtype, normal],
  );
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'R058d router-race fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [admin, `${admin}@test.local`]);
  await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)',
    [company, admin, 'admin']);

  const y = 2026;
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'R058d FY',1,$2,$3,$4,'open')`,
    [company, y, `${y}-01-01`, `${y}-12-31`],
  );

  await account('6000', 'R058d Expense', 'expense', 'default_expense', 'debit');
  await account('1000', 'R058d Bank', 'asset', 'bank', 'debit');
  await account('1300', 'R058d VAT Input', 'asset', 'vat_input', 'debit');
  await account('2000', 'R058d Payables', 'liability', 'payable', 'credit');
  clearSystemAccountCache(company);

  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date)
     VALUES($1,$2,'R058d-E1','Ray','Tester','2026-01-01')`,
    [employee, company],
  );

  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  adminToken = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(secret);
});

afterAll(async () => {
  try {
    await pool.query('UPDATE expense_claims SET posted_je_id=NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM expense_claim_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM expense_claims WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM capture_events WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

it('a legitimate routeEvent (no race) still transitions the event to extracted with data', async () => {
  const documentId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status)
     VALUES($1,$2,$3,'pdf','pending')`, [documentId, company, 'r058d-norace.pdf']);
  await pool.query(`INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
     VALUES($1,$2,'api','received',$3)`, [eventId, company, documentId]);

  await routeEvent(eventId, company);

  expect(await statusOf(eventId)).toBe('extracted');
  const { rows } = await pool.query(
    'SELECT extracted_data IS NOT NULL AS has FROM captured_documents WHERE id=$1', [documentId],
  );
  expect(rows[0].has).toBe(true);
});

it(
  "a post that lands and completes inside routeEvent's extracting window is not undone "
  + 'when routeEvent finishes afterwards',
  async () => {
    const documentId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status)
       VALUES($1,$2,$3,'pdf','pending')`, [documentId, company, 'r058d-race.pdf']);
    await pool.query(`INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
       VALUES($1,$2,'api','received',$3)`, [eventId, company, documentId]);

    const reached = new Promise<void>((resolveReached) => {
      beforeExtractedWrite = () => new Promise<void>((releaseHook) => {
        resolveReached();
        // Give the post time to reach the DB and commit before routeEvent's
        // delayed write is allowed to run.
        setTimeout(releaseHook, 500);
      });
    });

    const routing = routeEvent(eventId, company);
    await reached;

    // At this instant captured_documents.extracted_data is already committed
    // and capture_events.status is still 'extracting' — exactly the window
    // the postable allow-list treats as open.
    const mid = await call(eventId, { employeeId: employee });
    expect(mid.state.statusCode).toBe(200);
    expect(await claimsFor(documentId)).toBe(1);
    expect(await statusOf(eventId)).toBe('posted');

    await routing; // let routeEvent's delayed write run now that the post has committed

    // routeEvent's write must NOT have reverted the posted event or produced
    // a second claim.
    expect(await statusOf(eventId)).toBe('posted');
    expect(await claimsFor(documentId)).toBe(1);

    const second = await call(eventId, { employeeId: employee });
    expect(second.state.statusCode).toBe(400);
    expect(await claimsFor(documentId)).toBe(1);
  },
  30_000,
);
