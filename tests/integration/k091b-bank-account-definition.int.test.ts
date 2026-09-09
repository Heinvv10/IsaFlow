/**
 * One definition of CASH, one definition of a BANK ACCOUNT — and they are not
 * the same definition.
 *
 * Round 2 narrowed `bankGlAccountBelongsToCompany` and `fetchCoverageAccounts`
 * to `account_type = 'asset'`. That closed the leak (a liability overdraft
 * counted as cash) by opening its mirror: the same account vanished from the
 * coverage report, its imported statement lines went with it, and statement
 * import started refusing an id that the picker, bulk preview, bulk commit and
 * the feed pairing all still accept.
 *
 * This file pins BOTH directions.
 *   Visible : a subtype-`bank` account typed `liability` is still importable,
 *             still listed by the coverage report, flagged `misclassified`, and
 *             its whole statement balance is stated as unexplained.
 *   Closed  : it is still absent from `cash.balance.v1` and still contributes
 *             nothing to the exported opening cash balance — the K-091 defect.
 * Plus: the coverage totals FOOT to the account rows they summarise.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { NextApiRequest, NextApiResponse } from 'next';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { bankGlAccountBelongsToCompany } from '../../src/modules/accounting/services/bank/bankStatementImportService';
import { fetchCoverageAccounts } from '../../src/modules/accounting/services/bank/bankCoverageQueries';
import { getBankStatementCoverage } from '../../src/modules/accounting/services/bank/bankStatementCoverageService';
import { getCashBalance } from '../../src/modules/accounting/services/bank/cashBalanceService';
import { bankStatementCoverageTool } from '../../src/lib/mcp/tools/bankCoverage';

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
const glPettyCash = crypto.randomUUID();

const BANK_OPENING = 5000;
const CARD_OPENING = 900;
/** Petty cash: cash, but never a bank account. It separates the two questions. */
const PETTY_CASH = 250;
/** Statement lines imported against the mis-classified overdraft. */
const CARD_STATEMENT = -1234.56;

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
            ($4,$1,'K91B3000','Share Capital','equity','equity','credit',true),
            ($5,$1,'K91B4000','Petty Cash','asset','cash','debit',true)`,
    [company, glBank, glOverdraft, glEquity, glPettyCash]);

  await post('k091b-bank-open', '2025-12-01',
    [{ account: glBank, debit: BANK_OPENING, credit: 0 }, { account: glEquity, debit: 0, credit: BANK_OPENING }]);
  // The overdraft is drawn before the period. normal_balance is 'credit', so
  // the export's CASE turned this into a POSITIVE addition to opening cash.
  await post('k091b-card-open', '2025-12-02',
    [{ account: glEquity, debit: CARD_OPENING, credit: 0 }, { account: glOverdraft, debit: 0, credit: CARD_OPENING }]);

  await post('k091b-petty-open', '2025-12-03',
    [{ account: glPettyCash, debit: PETTY_CASH, credit: 0 }, { account: glEquity, debit: 0, credit: PETTY_CASH }]);

  // A statement line imported against the mis-classified account. This is the
  // row that silently left the coverage surface when the account was filtered.
  await pool.query(
    `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, reference)
     VALUES ($1,$2,'2026-03-04',$3,'card purchase','K91B-REF-1')`,
    [company, glOverdraft, CARD_STATEMENT]);

  route = (await import('../../pages/api/accounting/cash-flow-export'))
    .default as unknown as typeof route;
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  } finally { await pool.end(); }
});

// ── VISIBLE: the mis-classified account is not hidden ────────────────────────

it('still accepts a subtype-bank account for statement import whatever its type', async () => {
  expect(await bankGlAccountBelongsToCompany(company, glBank)).toBe(true);
  // Refusing this id here while the picker, bulk preview and bulk commit all
  // still offer it strands an account that already holds transactions.
  expect(await bankGlAccountBelongsToCompany(company, glOverdraft)).toBe(true);
  // The predicate is still a predicate: an equity account is not a bank account.
  expect(await bankGlAccountBelongsToCompany(company, glEquity)).toBe(false);
});

it('lists the mis-classified overdraft in the coverage report, carrying its type', async () => {
  const accounts = await fetchCoverageAccounts(company, '2026-12-31');
  const byCode = new Map(accounts.map((a) => [a.accountCode, a]));

  expect(byCode.get('K91B1000')?.accountType).toBe('asset');
  expect(byCode.get('K91B2000')?.accountType).toBe('liability');
  // Its statement line came with it rather than disappearing.
  expect(byCode.get('K91B2000')?.transactionCount).toBe(1);
  expect(byCode.get('K91B2000')?.netMovement).toBeCloseTo(CARD_STATEMENT, 2);
  expect(byCode.has('K91B3000')).toBe(false);
  // Petty cash is CASH but is not a bank account: it holds no statement lines
  // and belongs to the other question entirely.
  expect(byCode.has('K91B4000')).toBe(false);
});

it('flags the overdraft misclassified and states its whole statement balance as unexplained', async () => {
  const coverage = await getBankStatementCoverage(company, { asAt: '2026-12-31' });
  const card = coverage.accounts.find((a) => a.accountCode === 'K91B2000');
  const bank = coverage.accounts.find((a) => a.accountCode === 'K91B1000');

  expect(card?.misclassified).toBe(true);
  expect(bank?.misclassified).toBe(false);
  // No cash balance exists for it, so the difference states the statement
  // balance in full — visible, not netted away and not dropped.
  expect(card?.glBalance).toBe(0);
  expect(card?.statementBalance).toBeCloseTo(CARD_STATEMENT, 2);
  expect(card?.glVsComputedDifference).toBeCloseTo(-CARD_STATEMENT, 2);
});

it('foots: the coverage totals equal the sum of the account rows they summarise', async () => {
  const coverage = await getBankStatementCoverage(company, { asAt: '2026-12-31' });
  const bankRow = coverage.accounts.find((a) => a.accountCode === 'K91B1000');
  const sum = (pick: (a: (typeof coverage.accounts)[number]) => number): number =>
    coverage.accounts.reduce((acc, a) => acc + pick(a), 0);

  expect(coverage.totals.glBalance).toBeCloseTo(sum((a) => a.glBalance), 2);
  expect(coverage.totals.statementBalance).toBeCloseTo(sum((a) => a.statementBalance), 2);
  expect(coverage.totals.computedBalance).toBeCloseTo(sum((a) => a.computedBalance), 2);
  expect(coverage.totals.difference).toBeCloseTo(sum((a) => a.glVsComputedDifference), 2);
  expect(coverage.totals.transactionCount).toBe(sum((a) => a.transactionCount));

  // The GL side of each row is cash.balance.v1's own figure for that account,
  // and the total is the sum of exactly the rows shown — no account's GL money
  // is invented or dropped between the two services.
  const cash = await getCashBalance(company, '2026-12-31');
  const cashBy = new Map(cash.accounts.map((a) => [a.accountCode, a.glBalance]));
  expect(bankRow?.glBalance).toBeCloseTo(cashBy.get('K91B1000') ?? NaN, 2);
  expect(coverage.totals.glBalance).toBeCloseTo(
    (cashBy.get('K91B1000') ?? 0) + (cashBy.get('K91B2000') ?? 0), 2);

  // It is NOT cash.total, and asserting that identity would be asserting a
  // fixture rather than a rule: petty cash is cash the coverage report has no
  // business listing, so the two figures differ by exactly its balance.
  expect(cash.total - coverage.totals.glBalance).toBeCloseTo(PETTY_CASH, 2);
});

it('carries the flag out to the report\'s only consumer, the MCP coverage tool', async () => {
  // The service is not the surface a user sees; bank_statement_coverage is the
  // only caller, so a flag it does not project reaches nobody.
  const result = await bankStatementCoverageTool.handler(
    { as_at: '2026-12-31' },
    { userId: 'k091b', companyId: company, scopes: ['read:bank-tx'], tokenJti: null, oauthAppId: null },
  );
  const payload = JSON.parse(result.content[0]!.text) as {
    rows: Array<{ account_code: string; misclassified: boolean; gl_balance: number; statement_balance: number }>;
  };
  const card = payload.rows.find((r) => r.account_code === 'K91B2000');

  expect(card?.misclassified).toBe(true);
  expect(payload.rows.find((r) => r.account_code === 'K91B1000')?.misclassified).toBe(false);
  expect(card?.gl_balance).toBe(0);
  expect(card?.statement_balance).toBeCloseTo(CARD_STATEMENT, 2);
});

// ── CLOSED: it is still not cash ─────────────────────────────────────────────

it('keeps the overdraft out of cash.balance.v1', async () => {
  const cash = await getCashBalance(company, '2026-12-31');

  expect(cash.accounts.map((a) => a.accountCode).sort()).toEqual(['K91B1000', 'K91B4000']);
  expect(cash.total).toBeCloseTo(BANK_OPENING + PETTY_CASH, 2);
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

  // Cash and cash equivalents: the bank account plus petty cash. Unguarded, the
  // credit-normal overdraft ADDED R900 on top: 6150.00, not 5250.00.
  expect(opening).toContain((BANK_OPENING + PETTY_CASH).toFixed(2));
  expect(opening).not.toContain('6150.00');
});
