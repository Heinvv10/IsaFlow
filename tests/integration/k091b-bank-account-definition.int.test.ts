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
 *
 * Round 4 review, MEDIUM-1: the two questions were asked with different
 * vocabularies. Coverage matched the literal `'bank'`; `cash.balance.v1`
 * matches `CASH_SUBTYPES`, which also contains the raw spelling `bank_account`.
 * An asset-typed account spelled `bank_account` was therefore counted as cash,
 * held `bank_transactions` by FK, and had no coverage row at all — the same
 * "the row silently left the report" shape, in the direction the fix had not
 * closed. Both sides now read `BANK_SUBTYPES`, and this file pins that they
 * cannot disagree about ANY account shape rather than about the two the
 * fixture happens to seed.
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
import { BANK_SUBTYPES, CASH_SUBTYPES } from '../../src/modules/accounting/services/gl/accountSubtypes';

vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const glBank = crypto.randomUUID();
const glBankAlt = crypto.randomUUID();
const glOverdraft = crypto.randomUUID();
const glEquity = crypto.randomUUID();
const glPettyCash = crypto.randomUUID();

const BANK_OPENING = 5000;
/** The `bank_account` spelling. Cash by CASH_SUBTYPES; a bank account by BANK_SUBTYPES. */
const BANK_ALT_OPENING = 1400;
const CARD_OPENING = 900;
/** Petty cash: cash, but never a bank account. It separates the two questions. */
const PETTY_CASH = 250;
/** Statement lines imported against the mis-classified overdraft. */
const CARD_STATEMENT = -1234.56;
/** Statement lines imported against the `bank_account`-spelled account. */
const ALT_STATEMENT = -300;

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
            ($5,$1,'K91B4000','Petty Cash','asset','cash','debit',true),
            ($6,$1,'K91B5000','Bank - Savings','asset','bank_account','debit',true)`,
    [company, glBank, glOverdraft, glEquity, glPettyCash, glBankAlt]);

  await post('k091b-bank-open', '2025-12-01',
    [{ account: glBank, debit: BANK_OPENING, credit: 0 }, { account: glEquity, debit: 0, credit: BANK_OPENING }]);
  // The overdraft is drawn before the period. normal_balance is 'credit', so
  // the export's CASE turned this into a POSITIVE addition to opening cash.
  await post('k091b-card-open', '2025-12-02',
    [{ account: glEquity, debit: CARD_OPENING, credit: 0 }, { account: glOverdraft, debit: 0, credit: CARD_OPENING }]);

  await post('k091b-alt-open', '2025-12-04',
    [{ account: glBankAlt, debit: BANK_ALT_OPENING, credit: 0 },
     { account: glEquity, debit: 0, credit: BANK_ALT_OPENING }]);

  await post('k091b-petty-open', '2025-12-03',
    [{ account: glPettyCash, debit: PETTY_CASH, credit: 0 }, { account: glEquity, debit: 0, credit: PETTY_CASH }]);

  // A statement line imported against the mis-classified account. This is the
  // row that silently left the coverage surface when the account was filtered.
  await pool.query(
    `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, reference)
     VALUES ($1,$2,'2026-03-04',$3,'card purchase','K91B-REF-1')`,
    [company, glOverdraft, CARD_STATEMENT]);

  // And one against the `bank_account`-spelled account. Before BANK_SUBTYPES
  // this row had no coverage report to appear on while its balance was cash.
  await pool.query(
    `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, reference)
     VALUES ($1,$2,'2026-03-05',$3,'savings fee','K91B-REF-2')`,
    [company, glBankAlt, ALT_STATEMENT]);

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
  // The `bank_account` spelling is a bank account, listed with its statement line.
  expect(byCode.get('K91B5000')?.accountType).toBe('asset');
  expect(byCode.get('K91B5000')?.transactionCount).toBe(1);
  expect(byCode.get('K91B5000')?.netMovement).toBeCloseTo(ALT_STATEMENT, 2);
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
  expect(coverage.accounts.find((a) => a.accountCode === 'K91B5000')?.glBalance)
    .toBeCloseTo(cashBy.get('K91B5000') ?? NaN, 2);
  expect(coverage.totals.glBalance).toBeCloseTo(
    (cashBy.get('K91B1000') ?? 0) + (cashBy.get('K91B2000') ?? 0) + (cashBy.get('K91B5000') ?? 0), 2);

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

it('accepts the `bank_account` spelling for statement import too', async () => {
  // Nine query sites answer "does this account hold bank transactions?". They
  // matched the literal 'bank' while cash matched CASH_SUBTYPES, so this id was
  // cash the importer refused and the coverage report never listed.
  expect(await bankGlAccountBelongsToCompany(company, glBankAlt)).toBe(true);
});

it('coverage and cash.balance.v1 cannot disagree about ANY account shape', async () => {
  // The rule, not the fixture: every raw spelling BANK_SUBTYPES accepts is also
  // one CASH_SUBTYPES accepts, so an ASSET account carrying any of them must
  // appear on BOTH sides carrying the SAME balance. Seed one account per
  // spelling and check the whole cross-product, rather than the two shapes this
  // file happened to think of.
  expect(BANK_SUBTYPES.length).toBeGreaterThan(1);
  for (const spelling of BANK_SUBTYPES) expect(CASH_SUBTYPES).toContain(spelling);

  const probe = crypto.randomUUID();
  const seeded: Array<{ code: string; balance: number }> = [];
  try {
    await pool.query('INSERT INTO companies(id,name,is_active) VALUES($1,$2,true)', [probe, 'K091b shapes']);
    let n = 0;
    for (const spelling of BANK_SUBTYPES) {
      n += 1;
      const id = crypto.randomUUID();
      const equity = crypto.randomUUID();
      const code = `K91S${1000 + n}`;
      const balance = 100 * n;
      await pool.query(
        `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
         VALUES ($1,$2,$3,$4,'asset',$5,'debit',true),
                ($6,$2,$7,'Equity','equity','equity','credit',true)`,
        [id, probe, code, `Probe ${spelling}`, spelling, equity, `K91E${1000 + n}`]);
      const { rows } = await pool.query(
        `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
         VALUES ($1,$2,'2025-12-01','k091b shape probe','posted',$1) RETURNING id`, [probe, `k091b-shape-${n}`]);
      await pool.query(
        `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
         VALUES ($1,$2,$3,$4,0), ($1,$2,$5,0,$4)`, [probe, rows[0].id, id, balance, equity]);
      seeded.push({ code, balance });
    }

    const coverage = await getBankStatementCoverage(probe, { asAt: '2026-12-31' });
    const cash = await getCashBalance(probe, '2026-12-31');
    const coverageBy = new Map(coverage.accounts.map((a) => [a.accountCode, a.glBalance]));
    const cashBy = new Map(cash.accounts.map((a) => [a.accountCode, a.glBalance]));

    for (const { code, balance } of seeded) {
      // Present on both sides...
      expect(coverageBy.has(code)).toBe(true);
      expect(cashBy.has(code)).toBe(true);
      // ...carrying the same figure, and the figure that was actually posted.
      expect(coverageBy.get(code)).toBeCloseTo(balance, 2);
      expect(cashBy.get(code)).toBeCloseTo(balance, 2);
    }
    // No account is on one side only. Every cash account here IS a bank account
    // (nothing petty-cash-shaped was seeded), so the two sets are equal and the
    // totals are the same number.
    expect([...coverageBy.keys()].sort()).toEqual([...cashBy.keys()].sort());
    expect(coverage.totals.glBalance).toBeCloseTo(cash.total, 2);
    expect(cash.total).toBeCloseTo(seeded.reduce((sum, a) => sum + a.balance, 0), 2);
  } finally {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [probe]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [probe]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [probe]);
    await pool.query('DELETE FROM companies WHERE id=$1', [probe]);
  }
});

// ── CLOSED: it is still not cash ─────────────────────────────────────────────

it('keeps the overdraft out of cash.balance.v1', async () => {
  const cash = await getCashBalance(company, '2026-12-31');

  expect(cash.accounts.map((a) => a.accountCode).sort())
    .toEqual(['K91B1000', 'K91B4000', 'K91B5000']);
  expect(cash.total).toBeCloseTo(BANK_OPENING + PETTY_CASH + BANK_ALT_OPENING, 2);
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

  // Cash and cash equivalents: both bank accounts plus petty cash. Unguarded,
  // the credit-normal overdraft ADDED R900 on top.
  expect(opening).toContain((BANK_OPENING + PETTY_CASH + BANK_ALT_OPENING).toFixed(2));
  expect(opening).not.toContain((BANK_OPENING + PETTY_CASH + BANK_ALT_OPENING + CARD_OPENING).toFixed(2));
});
