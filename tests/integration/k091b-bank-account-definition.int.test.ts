/**
 * Round-2 MEDIUM-2 and MEDIUM-4 — one definition of a bank account.
 *
 * MEDIUM-2: `getCashBalance` gained `account_type = 'asset'`, but the two
 * predicates that decide what counts as a bank account for the per-account
 * readers — `bankGlAccountBelongsToCompany` and `fetchCoverageAccounts` —
 * filtered on `account_subtype = 'bank'` alone. A liability overdraft was
 * therefore still accepted and still listed, with its GL balance reading 0
 * through the `?? 0` fallback instead of its real value.
 *
 * MEDIUM-4: `pages/api/accounting/cash-flow-export.ts` was the twelfth and last
 * CASH_SUBTYPES reader without the guard, and its
 * `CASE WHEN normal_balance = 'debit' ... ELSE credit - debit END` made a
 * credit-normal card ADD its balance to opening cash.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { NextApiRequest, NextApiResponse } from 'next';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { bankGlAccountBelongsToCompany } from '../../src/modules/accounting/services/bank/bankStatementImportService';
import { fetchCoverageAccounts } from '../../src/modules/accounting/services/bank/bankCoverageQueries';

vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const glBank = crypto.randomUUID();
const glOverdraft = crypto.randomUUID();
const glEquity = crypto.randomUUID();

const BANK_OPENING = 5000;
const CARD_OPENING = 900;

let route: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

function mockRes(): { statusCode: number; body: unknown } & NextApiResponse {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    setHeader() { return res; },
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
    send(payload: unknown) { res.body = payload; return res; },
    end() { return res; },
  };
  return res as unknown as { statusCode: number; body: unknown } & NextApiResponse;
}

async function post(entryNumber: string, date: string,
  legs: Array<{ account: string; debit: number; credit: number }>): Promise<void> {
  const { rows } = await pool.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
     VALUES ($1,$2,$3,'k091b fixture','posted',$1) RETURNING id`, [company, entryNumber, date]);
  for (const leg of legs) {
    await pool.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1,$2,$3,$4,$5)`, [company, rows[0].id, leg.account, leg.debit, leg.credit]);
  }
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name,is_active) VALUES($1,$2,true)', [company, 'K091b fixture']);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES ($2,$1,'K91B1000','Bank - Current','asset','bank','debit',true),
            ($3,$1,'K91B2000','Overdraft Facility','liability','bank','credit',true),
            ($4,$1,'K91B3000','Share Capital','equity','equity','credit',true)`,
    [company, glBank, glOverdraft, glEquity]);

  await post('k091b-bank-open', '2025-12-01',
    [{ account: glBank, debit: BANK_OPENING, credit: 0 }, { account: glEquity, debit: 0, credit: BANK_OPENING }]);
  // The overdraft is drawn before the period. normal_balance is 'credit', so
  // the export's CASE turned this into a POSITIVE addition to opening cash.
  await post('k091b-card-open', '2025-12-02',
    [{ account: glEquity, debit: CARD_OPENING, credit: 0 }, { account: glOverdraft, debit: 0, credit: CARD_OPENING }]);

  route = (await import('../../pages/api/accounting/cash-flow-export'))
    .default as unknown as typeof route;
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  } finally { await pool.end(); }
});

it('refuses a liability overdraft as a bank account for statement import', async () => {
  expect(await bankGlAccountBelongsToCompany(company, glBank)).toBe(true);
  // Accepting it here while the cash figure reports its balance as 0 is what
  // made the coverage difference state the whole statement balance.
  expect(await bankGlAccountBelongsToCompany(company, glOverdraft)).toBe(false);
});

it('does not list a liability overdraft in the coverage report', async () => {
  const accounts = await fetchCoverageAccounts(company, '2026-12-31', null);
  const codes = accounts.map((a) => a.accountCode);

  expect(codes).toContain('K91B1000');
  expect(codes).not.toContain('K91B2000');
});

it('keeps the overdraft out of the exported opening cash balance', async () => {
  const res = mockRes();
  await route(
    {
      method: 'GET',
      query: { period_start: '2026-01-01', period_end: '2026-12-31' },
      headers: {},
      companyId: company,
      user: { id: 'k091b' },
    } as unknown as NextApiRequest,
    res,
  );

  const csv = String(res.body);
  const opening = csv.split('\n').find((l) => l.includes('Opening Balance'));

  // Unguarded, the credit-normal overdraft ADDED R900: 5900.00, not 5000.00.
  expect(opening).toContain(BANK_OPENING.toFixed(2));
  expect(opening).not.toContain('5900.00');
});
