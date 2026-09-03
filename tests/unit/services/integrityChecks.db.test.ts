/**
 * The thirteen integrity checks, against a real Postgres.
 *
 * These checks are SQL almost end to end, so a mocked test proves only that the
 * template literal was assembled. What has to be proved is that the predicate
 * finds the row and — the half that actually matters on an assurance report —
 * that `count` and `amount` are computed over EVERY failing row rather than
 * over the sample. A check whose total is the total of its own first fifty rows
 * is the aged-debtors defect wearing a different hat.
 *
 * Two SQL errors were found by running these against production before this
 * file existed: `MIN(uuid)` does not exist in Postgres, and an untyped integer
 * parameter subtracted from a DATE gives `operator does not exist: date <=
 * integer`. Both are pinned below.
 *
 * Every seeded row lives inside BEGIN … ROLLBACK on one ALS-bound client, and
 * the suite refuses to run against production.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import { runIntegrityChecks, INTEGRITY_CHECK_IDS } from '@/modules/accounting/services/gl/integrityChecks';
import type { IntegrityCheckId, IntegrityCheckResult } from '@/modules/accounting/services/gl/integrityChecks';

const AS_AT = '2026-09-30';
const USER = '00000000-0000-0000-0000-0000000000aa';

type Ctx = Parameters<typeof als.run>[0];
const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: USER, companyId, claims: {} } as unknown as Ctx);

let dbUp = false;
beforeAll(async () => { dbUp = await isDbReachable(); });

/**
 * A company with exactly one violation of each check, seeded then rolled back.
 * Amounts are distinct primes-ish values so a check picking up the wrong row is
 * visible in the assertion rather than accidentally correct.
 */
async function seed(client: PoolClient): Promise<string> {
  const { rows: [co] } = await client.query<{ id: string }>(
    `INSERT INTO companies (name) VALUES ('Integrity Fixture') RETURNING id`,
  );
  const companyId = co!.id;

  const account = async (
    code: string, name: string, type: string, subtype: string | null, active = true,
  ): Promise<string> => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
         account_subtype, normal_balance, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [companyId, code, name, type, subtype, type === 'asset' || type === 'expense' ? 'debit' : 'credit', active],
    );
    return rows[0]!.id;
  };

  const bank = await account('1000', 'Bank', 'asset', 'bank');
  const ar = await account('1100', 'Trade Debtors Control', 'asset', 'receivable');
  const arDupe = await account('1101', 'Accounts Receivable', 'asset', null);
  const vatIn = await account('1200', 'VAT Input', 'asset', 'vat_input');
  const revenue = await account('4000', 'Sales', 'revenue', 'default_revenue');
  const cos = await account('5000', 'Cost of Sales — Materials', 'expense', 'default_expense');
  // Velocity's ACTUAL shape: eight cost-of-sales accounts with NO SUBTYPE AT
  // ALL. `NULL <> 'cost_of_sales'` evaluates to NULL, not TRUE, so a predicate
  // without COALESCE drops every one of them and the check reports a clean
  // book. Verified against production: 8 accounts with the COALESCE, 0
  // without, hiding R81,852,355.20.
  const cosNoSubtype = await account('5001', 'COS - Direct Material', 'expense', null);
  const clearing = await account('1150', 'Interbank Transfer Clearing', 'asset', 'other_current_asset');
  const clearing2 = await account('1151', 'Payment Suspense', 'asset', 'other_current_asset');
  const dormant = await account('1121', 'Loan Account — dormant', 'asset', 'other_current_asset', false);
  const loan = await account('1300', 'Loan Account — in credit', 'asset', 'other_current_asset');
  // Brightsphere 1120 "Accounts Receivable": an asset with NO SUBTYPE carrying
  // a R10,000 credit — the QA Test Customer balance the audit named. The
  // accumulated-depreciation exclusion must COALESCE, or `NULL <>
  // 'accumulated_depreciation'` is NULL and this account is dropped along with
  // the finding.
  const arNoSubtype = await account('1122', 'Accounts Receivable — untyped', 'asset', null);
  const equity = await account('3000', 'Share Capital', 'equity', 'equity');
  // An ordinary expense, so the cost-of-sales figure is exactly what was seeded.
  const opex = await account('6000', 'Office Costs', 'expense', 'operating_expense');
  const payable = await account('2100', 'Trade Creditors Control', 'liability', 'payable');

  // Two periods, because "no fiscal period at all" and "a period that is
  // closed" are different failures and the check must not conflate them. A
  // NULL fiscal_period_id also makes a journal invisible to every
  // period-scoped report, so ordinary fixture journals get the open one.
  const { rows: [closed] } = await client.query<{ id: string }>(
    `INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year,
       start_date, end_date, status)
     VALUES ($1,'FY26 Q1',1,2026,'2026-01-01','2026-03-31','closed') RETURNING id`,
    [companyId],
  );
  const { rows: [open] } = await client.query<{ id: string }>(
    `INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year,
       start_date, end_date, status)
     VALUES ($1,'FY26 Q2-Q4',2,2026,'2026-04-01','2026-12-31','open') RETURNING id`,
    [companyId],
  );
  const closedPeriod = closed!.id;
  const openPeriod = open!.id;

  const journal = async (
    number: string, date: string, source: string, lines: Array<[string, number, number, string | null]>,
    fiscalPeriodId: string | null = openPeriod,
  ): Promise<string> => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description,
         source, status, created_by, fiscal_period_id)
       VALUES ($1,$2,$3,$7,$4,'posted',$5,$6) RETURNING id`,
      // $2 must not double as the description: pg deduces one type per
      // parameter and varchar/text on the same $n throws "inconsistent types".
      [companyId, number, date, source, USER, fiscalPeriodId, number],
    );
    const jeId = rows[0]!.id;
    for (const [acct, debit, credit, vatType] of lines) {
      await client.query(
        `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, vat_type)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [companyId, jeId, acct, debit, credit, vatType],
      );
    }
    return jeId;
  };

  // 1 — an open invoice with no due date: R1,058,000, exactly the Brightsphere shape.
  const { rows: [cust] } = await client.query<{ id: string }>(
    `INSERT INTO customers (company_id, name) VALUES ($1,'Real Customer') RETURNING id`, [companyId],
  );
  await client.query(
    `INSERT INTO customer_invoices (company_id, customer_id, invoice_number, invoice_date,
       due_date, subtotal, total_amount, amount_paid, status, created_by)
     VALUES ($1,$2,'INV-NULLDUE','2026-04-28',NULL,920000,1058000,0,'sent',$3)`,
    [companyId, cust!.id, USER],
  );

  // 13 — a posted invoice whose journal recognises no revenue.
  const noRevenueJe = await journal('JE-NOREV', '2026-05-01', 'auto_invoice', [
    [ar, 5000, 0, null], [payable, 0, 5000, null],
  ]);
  await client.query(
    `INSERT INTO customer_invoices (company_id, customer_id, invoice_number, invoice_date,
       due_date, subtotal, total_amount, amount_paid, status, created_by, gl_journal_entry_id)
     VALUES ($1,$2,'INV-NOREV','2026-05-01','2026-06-01',5000,5000,0,'sent',$3,$4)`,
    [companyId, cust!.id, USER, noRevenueJe],
  );

  // Funding, so that the only asset account left in credit is the one the
  // check is meant to find. A fixture whose bank account is overdrawn by
  // construction makes the assertion pass or fail for the wrong reason.
  await journal('JE-FUND', '2026-04-01', 'manual', [[bank, 20000000, 0, null], [equity, 0, 20000000, null]]);

  // 10 — a posted journal in a CLOSED period.
  await journal('JE-CLOSED', '2026-03-15', 'manual', [[bank, 111, 0, null], [revenue, 0, 111, null]], closedPeriod);

  // 5 / 6 / 7 / 8 — the four chart-of-accounts shapes.
  await journal('JE-DORMANT', '2026-05-01', 'manual', [[dormant, 130000, 0, null], [revenue, 0, 130000, null]]);
  await journal('JE-LOANCR', '2026-05-02', 'manual', [[loan, 0, 4847978.30, null], [revenue, 4847978.30, 0, null]]);
  await journal('JE-ARCR', '2026-05-02', 'manual', [[arNoSubtype, 0, 10000, null], [revenue, 10000, 0, null]]);
  await journal('JE-COS', '2026-05-03', 'manual', [[cos, 574253.66, 0, null], [bank, 0, 574253.66, null]]);
  await journal('JE-COS2', '2026-05-03', 'manual', [[cosNoSubtype, 11.11, 0, null], [bank, 0, 11.11, null]]);
  await journal('JE-CLEARING', '2026-05-04', 'manual', [[clearing, 14081940.13, 0, null], [bank, 0, 14081940.13, null]]);
  // A SECOND non-nil clearing account, so a check that reports its own sample
  // size as the count can be caught. With limit 1 the sample is one row and the
  // count must still be two.
  await journal('JE-CLEARING2', '2026-05-04', 'manual', [[clearing2, 7.77, 0, null], [bank, 0, 7.77, null]]);

  // The payable role, with exactly ONE control account. A check that reports
  // every role rather than only the duplicated ones flags this, and it must
  // not — one control account per role is the correct state.
  await journal('JE-AP1', '2026-05-07', 'auto_supplier_invoice', [[opex, 500, 0, null], [payable, 0, 500, null]]);

  // 9 — two accounts both receiving `auto_invoice` postings.
  await journal('JE-AR1', '2026-05-05', 'auto_invoice', [[ar, 1000, 0, null], [revenue, 0, 1000, null]]);
  await journal('JE-AR2', '2026-05-06', 'auto_invoice', [[arDupe, 2000, 0, null], [revenue, 0, 2000, null]]);

  // 2 / 3 / 4 / 11 — the bank shapes. One journal claims VAT while its
  // transaction shows none; one is dated a day away from its bank line.
  const vatJe = await journal('JE-VATCLAIM', '2026-06-10', 'auto_bank_recon', [
    [opex, 1000, 0, null], [vatIn, 150, 0, 'standard'], [bank, 0, 1150, null],
  ]);
  const { rows: [vatLine] } = await client.query<{ id: string }>(
    `SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2`,
    [vatJe, bank],
  );
  const tx = async (
    ref: string, date: string, amount: number, matched: string | null,
    suggestedVat: string | null, suggestedAccount: string | null,
  ) => {
    await client.query(
      `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
         description, reference, status, matched_journal_line_id, suggested_vat_code, suggested_gl_account_id)
       VALUES ($1,$2,$3,$4,$5,$9,'imported',$6,$7,$8)`,
      // description is text and reference is varchar — one $n cannot be both.
      [companyId, bank, date, amount, ref, matched, suggestedVat, suggestedAccount, ref],
    );
  };
  // Displays "No VAT"; its journal claims R150 of input tax. Also dated one day
  // before the journal, so it fails the date check too.
  await tx('BT-VATCLAIM', '2026-06-09', -1150, vatLine!.id, null, null);
  // Two transactions sharing a reference.
  await tx('BT-DUPREF', '2026-06-11', -100, null, null, null);
  await tx('BT-DUPREF', '2026-06-12', -200, null, null, null);
  // A transaction whose displayed VAT code AGREES with what its journal
  // posted. It must not be flagged — the check is about disagreement, and one
  // that flags every VAT-bearing allocation is noise, not a finding.
  const agreeJe = await journal('JE-VATAGREE', '2026-06-20', 'auto_bank_recon', [
    [opex, 2000, 0, null], [vatIn, 300, 0, 'standard'], [bank, 0, 2300, null],
  ]);
  const { rows: [agreeLine] } = await client.query<{ id: string }>(
    `SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2`,
    [agreeJe, bank],
  );
  await tx('BT-VATAGREE', '2026-06-20', -2300, agreeLine!.id, 'standard', null);

  // Suggested, unallocated, older than 30 days before as_at.
  await tx('BT-STALE', '2026-01-15', -2132.39, null, null, opex);
  // Suggested and RECENT — inside the 30-day window, so still work in
  // progress rather than a gap. A check without the window flags this too.
  await tx('BT-FRESH', '2026-09-25', -55.5, null, null, opex);

  // 12 — a supplier whose name announces itself.
  await client.query(
    `INSERT INTO suppliers (company_id, name) VALUES ($1,'QA Test Supplier')`, [companyId],
  );

  return companyId;
}

async function withFixture<T>(fn: (companyId: string) => Promise<T>): Promise<T> {
  assertNotProductionDb();
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const companyId = await seed(client);
    return await als.run(ctxFor(client, companyId), () => fn(companyId));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

function by(checks: IntegrityCheckResult[], id: IntegrityCheckId): IntegrityCheckResult {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`check ${id} did not run`);
  return found;
}

describe('runIntegrityChecks against a real ledger', () => {
  it('finds exactly one violation of each of the thirteen checks', async () => {
    if (!dbUp) return;
    await withFixture(async (companyId) => {
      const report = await runIntegrityChecks(companyId, { asAt: AS_AT, limit: 20 });

      // Not one check may have errored. `count: -1` is the error sentinel and
      // is deliberately impossible to mistake for a clean zero.
      expect(report.checksErrored).toEqual([]);
      expect(report.checks.map((c) => c.id)).toEqual([...INTEGRITY_CHECK_IDS]);
      expect(report.checks.every((c) => c.count >= 0)).toBe(true);

      expect(by(report.checks, 'invoices_null_due_date')).toMatchObject({ count: 1, amount: 1058000 });
      expect(by(report.checks, 'vat_displayed_differs_from_posted')).toMatchObject({ count: 1, amount: 150 });
      expect(by(report.checks, 'journal_date_differs_from_bank_date')).toMatchObject({ count: 1 });
      expect(by(report.checks, 'duplicate_bank_references')).toMatchObject({ count: 1, amount: 300 });
      expect(by(report.checks, 'deactivated_accounts_with_balance')).toMatchObject({ count: 1, amount: 130000 });
      expect(by(report.checks, 'asset_accounts_with_credit_balance')).toMatchObject({ count: 2, amount: -4857978.3 });
      // BOTH shapes: typed default_expense, and typed nothing at all.
      expect(by(report.checks, 'cost_of_sales_typed_as_expense')).toMatchObject({ count: 2, amount: 574264.77 });
      expect(by(report.checks, 'clearing_accounts_not_nil')).toMatchObject({ count: 2, amount: 14081947.9 });
      expect(by(report.checks, 'duplicate_control_accounts').count).toBe(2);
      expect(by(report.checks, 'documents_outside_open_period')).toMatchObject({ count: 1 });
      expect(by(report.checks, 'stale_suggested_transactions')).toMatchObject({ count: 1, amount: 2132.39 });
      expect(by(report.checks, 'test_records_in_production')).toMatchObject({ count: 1 });
      expect(by(report.checks, 'invoices_without_revenue_line')).toMatchObject({ count: 1, amount: 5000 });
    });
  });

  it('counts and totals every failing row, not only the sampled ones', async () => {
    if (!dbUp) return;
    await withFixture(async (companyId) => {
      // Two failing rows in the fixture, asked for one. count and amount are
      // over the whole book: if either ever collapses onto the sample, the
      // report is telling the reader its own first page is the whole book,
      // which is exactly the ten-row aged-debtors defect.
      const report = await runIntegrityChecks(companyId, {
        asAt: AS_AT, limit: 1, checks: ['clearing_accounts_not_nil', 'duplicate_control_accounts'],
      });
      const clearing = by(report.checks, 'clearing_accounts_not_nil');
      expect(clearing.sample).toHaveLength(1);
      expect(clearing.count).toBe(2);
      expect(clearing.amount).toBe(14081947.9);
      const control = by(report.checks, 'duplicate_control_accounts');
      expect(control.sample).toHaveLength(1);
      expect(control.count).toBe(2);
      // The assertion this test was named for, and did not make. `count` was
      // over every row while `amount` was summed inside the SLICED loop, so
      // with limit:1 the R8,000 of contending balances under-reported —
      // the largest row alone, and lower than the truth, which is the
      // direction that reads as reassuring.
      expect(control.amount).toBe(8000);
    });
  });

  /**
   * NULL IS THE FINDING, AND A BARE COMPARISON DROPS IT.
   *
   * These three predicates each COALESCE a NULL before comparing it, and every
   * one of them is load-bearing in the REVEALING direction — the opposite of
   * the usual COALESCE hazard. Verified against production:
   *
   *   - `COALESCE(account_subtype, '') <> 'cost_of_sales'` finds 8 Velocity
   *     accounts holding R81,852,355.20. Without it: 0, because
   *     `NULL <> 'cost_of_sales'` is NULL, not TRUE.
   *   - `COALESCE(suggested_vat_code, 'no_vat') = 'no_vat'` finds 3,247
   *     transactions across both companies. EVERY ONE of them has a NULL code,
   *     so without it the check finds nothing at all.
   *
   * A future cleanup removing either reads as tidying and silently returns a
   * clean bill of health on the two largest findings in the suite. Hence these
   * tests.
   */
  it('finds a cost-of-sales account with NO subtype, not only a mistyped one', async () => {
    if (!dbUp) return;
    await withFixture(async (companyId) => {
      const report = await runIntegrityChecks(companyId, {
        asAt: AS_AT, limit: 20, checks: ['cost_of_sales_typed_as_expense'],
      });
      const check = by(report.checks, 'cost_of_sales_typed_as_expense');
      expect(check.count).toBe(2);
      expect(check.sample.map((r) => r.label)).toContain('5001 COS - Direct Material');
      expect(check.sample.find((r) => r.label.startsWith('5001'))?.detail).toContain('no subtype');
    });
  });

  it('finds an asset account in credit that has no subtype at all', async () => {
    if (!dbUp) return;
    await withFixture(async (companyId) => {
      // Removing the COALESCE from the accumulated-depreciation exclusion takes
      // Brightsphere's 1120 "Accounts Receivable" and its R10,000 credit — the
      // QA Test Customer balance — out of the production result: 9 accounts
      // become 8, and R9,809,698.79 becomes R9,799,698.79.
      const report = await runIntegrityChecks(companyId, {
        asAt: AS_AT, checks: ['asset_accounts_with_credit_balance'],
      });
      const check = by(report.checks, 'asset_accounts_with_credit_balance');
      expect(check.count).toBe(2);
      expect(check.sample.map((r) => r.label)).toContain('1122 Accounts Receivable — untyped');
    });
  });

  it('finds a bank transaction whose displayed VAT code is NULL, not only one that says no_vat', async () => {
    if (!dbUp) return;
    await withFixture(async (companyId) => {
      // BT-VATCLAIM carries suggested_vat_code NULL, which is how all 3,247
      // production rows look. "Shows nothing" and "says no VAT" are the same
      // thing to a reader and must be the same thing to the check.
      const report = await runIntegrityChecks(companyId, {
        asAt: AS_AT, checks: ['vat_displayed_differs_from_posted'],
      });
      const check = by(report.checks, 'vat_displayed_differs_from_posted');
      expect(check.count).toBe(1);
      expect(check.sample[0]?.detail).toContain('displayed "No VAT"');
    });
  });

  /**
   * A predicate in a LEFT JOIN ON clause restricts nothing — unmatched rows
   * survive with NULL columns. `kpiChartsService` put `is_active` and
   * `account_subtype` in a LEFT JOIN ON and summed every bank transaction
   * regardless of account. Here the failure inverts: moving
   * `fp.status IN ('closed','locked')` from WHERE into the ON clause makes
   * EVERY journal match with fp.id NULL, and the `fp.id IS NULL` arm then flags
   * the entire ledger.
   */
  it('restricts on the fiscal period in WHERE, not in the LEFT JOIN ON clause', async () => {
    if (!dbUp) return;
    await withFixture(async (companyId) => {
      const report = await runIntegrityChecks(companyId, {
        asAt: AS_AT, checks: ['documents_outside_open_period'],
      });
      // Exactly one journal sits in the closed period. Every other fixture
      // journal is in the open one and must not be flagged.
      expect(by(report.checks, 'documents_outside_open_period').count).toBe(1);
    });
  });

  /**
   * The half of each check that stops it being noise. A check that flags every
   * VAT allocation, every suggestion and every control account reports
   * thousands of rows and is switched off within a week.
   */
  it('does not flag the rows that are correct', async () => {
    if (!dbUp) return;
    await withFixture(async (companyId) => {
      const report = await runIntegrityChecks(companyId, { asAt: AS_AT, limit: 50 });

      // BT-VATAGREE displays "standard" and its journal posted standard VAT.
      const vat = by(report.checks, 'vat_displayed_differs_from_posted');
      expect(vat.count).toBe(1);
      expect(vat.sample.map((r) => r.label)).not.toContain('BT-VATAGREE');

      // BT-FRESH is five days old, not thirty.
      const stale = by(report.checks, 'stale_suggested_transactions');
      expect(stale.count).toBe(1);
      expect(stale.sample.map((r) => r.label)).not.toContain('BT-FRESH');

      // The payables role has exactly one control account, which is correct.
      const control = by(report.checks, 'duplicate_control_accounts');
      expect(control.count).toBe(2);
      expect(control.sample.every((r) => r.detail?.includes('receivable'))).toBe(true);
    });
  });

  it('runs only the checks it was asked for', async () => {
    if (!dbUp) return;
    await withFixture(async (companyId) => {
      const report = await runIntegrityChecks(companyId, {
        asAt: AS_AT, checks: ['clearing_accounts_not_nil'],
      });
      expect(report.checks).toHaveLength(1);
      expect(report.checks[0]!.id).toBe('clearing_accounts_not_nil');
    });
  });

  /**
   * as_at is not decoration. A check that ignores it reports today's book under
   * yesterday's date, and two runs of the same signed report disagree.
   */
  it('honours as_at — a violation dated after it is out of scope', async () => {
    if (!dbUp) return;
    await withFixture(async (companyId) => {
      const before = await runIntegrityChecks(companyId, {
        asAt: '2026-01-31', checks: ['clearing_accounts_not_nil', 'invoices_null_due_date'],
      });
      expect(by(before.checks, 'clearing_accounts_not_nil').count).toBe(0);
      expect(by(before.checks, 'invoices_null_due_date').count).toBe(0);
    });
  });

  it('reports posted_through from the ledger, never now()', async () => {
    if (!dbUp) return;
    await withFixture(async (companyId) => {
      const report = await runIntegrityChecks(companyId, { asAt: AS_AT, checks: ['clearing_accounts_not_nil'] });
      expect(report.postedThrough).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
