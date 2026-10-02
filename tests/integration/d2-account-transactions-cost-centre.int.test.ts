/**
 * D2 — the account-transactions report AND its CSV export narrow to one cost
 * centre when asked with `cost_centre_id` (the name the routes read), on the
 * real schema. The page used to send `cost_centre`, which both routes ignore.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { NextApiResponse } from 'next';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true) }));
import report from '../../pages/api/accounting/reports-account-transactions';
import exportCsv from '../../pages/api/accounting/account-transactions-export';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const sales = crypto.randomUUID();
const ccA = crypto.randomUUID();
const ccB = crypto.randomUUID();
const period = crypto.randomUUID();
const range = { period_start: '2026-04-01', period_end: '2026-04-30', account_code: '1100' };

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'D2 account txns fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
    VALUES($1,$3,'1100','Bank','asset','debit',1,true),($2,$3,'4000','Sales','revenue','credit',1,true)`, [bank, sales, company]);
  await pool.query(`INSERT INTO cost_centres(id,company_id,code,name,is_active) VALUES($1,$3,'A','Centre A',true),($2,$3,'B','Centre B',true)`, [ccA, ccB, company]);
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date)
    VALUES($1,$2,'2026-04',2,2026,'2026-04-01','2026-04-30')`, [period, company]);
  for (const [n, cc, amount] of [[1, ccA, 10], [2, ccA, 20], [3, ccB, 400]] as const) {
    const je = crypto.randomUUID();
    await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,created_by,status,description,fiscal_period_id,entry_number)
      VALUES($1,$2,'2026-04-10',$3,'posted',$4,$5,$6)`, [je, company, user, `Sale ${n}`, period, `D2-${n}`]);
    await pool.query(`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,cost_center_id)
      VALUES($1,$2,$3,$5,0,$6),($1,$2,$4,0,$5,$6)`, [company, je, bank, sales, amount, cc]);
  }
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM cost_centres WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function call(handler: unknown, query: Record<string, string>) {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    status(c: number) { out.status = c; return this; },
    json(b: unknown) { out.body = b; return this; },
    send(b: unknown) { out.status ||= 200; out.body = b; return this; },
    setHeader() { return this; },
  };
  const client = await pool.connect();
  try {
    await als.run({ client, companyId: company, userId: user, claims: {} } as never, async () => {
      await (handler as (a: unknown, b: NextApiResponse) => Promise<unknown>)(
        { method: 'GET', companyId: company, query: { ...range, ...query } }, res as unknown as NextApiResponse);
    });
  } finally { client.release(); }
  return out;
}

describe('cost_centre_id narrows the account-transactions report and its export', () => {
  it('report: all centres 3 rows, centre A 2 rows, centre B 1 row', async () => {
    const rows = async (q: Record<string, string>) =>
      ((await call(report, q)).body as { data: { transactions: { debit: number }[] } }).data.transactions.map(t => t.debit);
    expect(await rows({})).toEqual([10, 20, 400]);
    expect(await rows({ cost_centre_id: ccA })).toEqual([10, 20]);
    expect(await rows({ cost_centre_id: ccB })).toEqual([400]);
  });

  it('export: the CSV carries only the selected centre, and a non-UUID is refused', async () => {
    const lines = async (q: Record<string, string>) => ((await call(exportCsv, q)).body as string).split('\n');
    expect(await lines({})).toHaveLength(3 + 3);                        // header + opening + closing + 3 rows
    const a = await lines({ cost_centre_id: ccA });
    expect(a).toHaveLength(3 + 2);
    expect(a.join('\n')).not.toContain('400.00');
    expect((await call(exportCsv, { cost_centre_id: 'not-a-uuid' })).status).toBe(400);
  });
});
