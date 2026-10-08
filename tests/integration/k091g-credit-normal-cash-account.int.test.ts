// tests/integration/k091g-credit-normal-cash-account.int.test.ts
//
// A cash account is an ASSET, and an asset's balance is debit less credit —
// whatever its `normal_balance` column says. The column is user-set (account
// create API, CSV import), so a cash account can carry 'credit'.
//
// Six cash sums signed each account by `normal_balance` instead:
// `afsKpiCash.fetchOpeningCash`/`fetchClosingCash`, `cashFlowReconciliation`'s
// `fetchIndirectClosingCash`/`fetchBankBalance`, and the opening cash of the
// `reports-cash-flow` and `cash-flow-export` routes. A credit-normal petty cash
// float holding R300 was therefore summed as −R300: cash came back R600 short
// of `getCashBalance` (cash.balance.v1), of `cashFlowDirectService`, and of the
// balance sheet's cash line beside it. The balance sheet had the same defect
// for debit-normal equity (balanceSheetContraSign.test.ts).
//
// The K-091 family's other files stay as they are; this is its own file for
// the 300-line limit. Seeds a company, so it runs only on a disposable DB.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { fetchOpeningCash, fetchClosingCash } from '@/modules/accounting/services/afs/afsKpiCash';
import { getCashFlowReconciliation } from '@/modules/accounting/services/afs/cashFlowReconciliationService';

vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = isDisposableDb(DATABASE_URL) ? describe : describe.skip;

const COMPANY = randomUUID();
const GL_BANK = randomUUID();
const GL_PETTY = randomUUID();
const GL_EQUITY = randomUUID();
const GL_OPEX = randomUUID();

const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-12-31';

const BANK_OPENING = 5000;  // posted 2025-12-01
const PETTY_OPENING = 300;  // posted 2025-12-02, into the CREDIT-normal float
const PETTY_SPEND = 100;    // 2026-03-01, out of the float

/** Debit less credit, per asset: 5 300 opening, 5 200 closing. */
const OPENING_CASH = BANK_OPENING + PETTY_OPENING;
const CLOSING_CASH = OPENING_CASH - PETTY_SPEND;

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

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

function get(query: Record<string, string>): NextApiRequest {
  return { method: 'GET', query, headers: {}, companyId: COMPANY, user: { id: 'k091g' } } as unknown as NextApiRequest;
}

describeIfDb('K-091g a credit-normal cash account is still cash, debit less credit', () => {
  let admin: Pool;

  async function post(entryNumber: string, entryDate: string,
    legs: Array<{ account: string; debit: number; credit: number }>): Promise<void> {
    const { rows } = await admin.query(
      `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
       VALUES ($1, $2, $3, 'k091g fixture', 'posted', $1) RETURNING id`, [COMPANY, entryNumber, entryDate]);
    for (const leg of legs) {
      await admin.query(
        `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
         VALUES ($1, $2, $3, $4, $5)`, [COMPANY, rows[0].id, leg.account, leg.debit, leg.credit]);
    }
  }

  beforeAll(async () => {
    assertDisposableDb('This test inserts and deletes a company, its accounts and journals.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await admin.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, 'K091g fixture', true)`, [COMPANY]);
    await admin.query(
      `INSERT INTO gl_accounts
         (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES
         ($2, $1, 'K91G1000', 'Bank - Current',     'asset',   'bank',              'debit',  true),
         -- The defect's trigger: an asset whose normal_balance was set to credit.
         ($3, $1, 'K91G1010', 'Petty Cash',         'asset',   'petty_cash',        'credit', true),
         ($4, $1, 'K91G3000', 'Share Capital',      'equity',  'equity',            'credit', true),
         ($5, $1, 'K91G5000', 'Operating Expenses', 'expense', 'operating_expense', 'debit',  true)`,
      [COMPANY, GL_BANK, GL_PETTY, GL_EQUITY, GL_OPEX],
    );
    await post('k091g-bank-open', '2025-12-01', [
      { account: GL_BANK, debit: BANK_OPENING, credit: 0 },
      { account: GL_EQUITY, debit: 0, credit: BANK_OPENING },
    ]);
    await post('k091g-petty-open', '2025-12-02', [
      { account: GL_PETTY, debit: PETTY_OPENING, credit: 0 },
      { account: GL_EQUITY, debit: 0, credit: PETTY_OPENING },
    ]);
    await post('k091g-petty-spend', '2026-03-01', [
      { account: GL_OPEX, debit: PETTY_SPEND, credit: 0 },
      { account: GL_PETTY, debit: 0, credit: PETTY_SPEND },
    ]);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    try {
      await admin.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [COMPANY]);
      await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [COMPANY]);
      await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
      await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    } finally { await admin.end(); }
  });

  it('cash.balance.v1 reads the float debit less credit — the definition the others must match', async () => {
    expect((await getCashBalance(COMPANY, PERIOD_START, { exclusive: true })).total).toBeCloseTo(OPENING_CASH, 2);
    expect((await getCashBalance(COMPANY, PERIOD_END)).total).toBeCloseTo(CLOSING_CASH, 2);
  });

  it('the AFS cash KPI reads opening and closing cash the same way', async () => {
    expect(await fetchOpeningCash(COMPANY, PERIOD_START)).toBeCloseTo(OPENING_CASH, 2);
    expect(await fetchClosingCash(COMPANY, PERIOD_END)).toBeCloseTo(CLOSING_CASH, 2);
  });

  it('the cash flow reconciliation reads the bank balance and indirect closing the same way', async () => {
    const recon = await getCashFlowReconciliation(COMPANY, PERIOD_START, PERIOD_END);
    expect(recon.bankBalance).toBeCloseTo(CLOSING_CASH, 2);
    expect(recon.indirectClosing).toBeCloseTo(CLOSING_CASH, 2);
  });

  it('the cash flow report states opening cash the same way', async () => {
    const route = (await import('../../pages/api/accounting/reports-cash-flow')).default as unknown as Route;
    const res = mockRes();
    await route(get({ period_start: PERIOD_START, period_end: PERIOD_END }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { data: { report: { opening_cash: number } } };
    expect(body.data.report.opening_cash).toBeCloseTo(OPENING_CASH, 2);
  });

  it('the cash flow CSV export states opening cash the same way', async () => {
    const route = (await import('../../pages/api/accounting/cash-flow-export')).default as unknown as Route;
    const res = mockRes();
    await route(get({ period_start: PERIOD_START, period_end: PERIOD_END }), res);
    const opening = String(res.body).split('\n').find((l) => l.includes('Opening Balance'));
    expect(opening).toBeDefined();
    expect(opening!.endsWith(`,${OPENING_CASH.toFixed(2)}`)).toBe(true);
  });
});
