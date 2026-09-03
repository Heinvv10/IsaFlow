// tests/integration/bank-account-gl-refs.int.test.ts
//
// A "bank account" in IsaFlow is a gl_accounts row with account_subtype='bank'.
// bank_transactions.bank_account_id has a foreign key to gl_accounts(id) — not
// to bank_accounts(id) — and every row in dev and production honours that.
// The bank_accounts table is vestigial metadata: 1 row on dev, 0 rows on prod.
//
// Three call sites were still reading bank_accounts, so they could never return
// anything real:
//
//   customReportFieldDefs   joined bank_accounts and selected `ba.name`, a
//                           column bank_accounts does not have → 42703.
//   consolidatedReporting   summed bank_accounts.current_balance for a group's
//                           combined cash position → always 0 in production.
//   setup-guide             counted bank_accounts rows → the 'bank-account'
//                           setup task could never complete.
//
// These tests run the real queries against the real schema, so they fail if any
// of the three regresses to bank_accounts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { runReport } from '@/modules/accounting/services/reports/customReportRunner';
import { getGroupDashboardStats } from '@/modules/accounting/services/reports/consolidatedReportingService';
import { countBankAccounts } from '@/modules/accounting/services/bank/hasBankAccountService';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

const GROUP = '00000000-0000-0000-0000-00000000ba90';
const COMPANY_A = '00000000-0000-0000-0000-00000000ba01';
const COMPANY_B = '00000000-0000-0000-0000-00000000ba02';
// gl_accounts rows — these are the bank accounts.
const GL_BANK_A = '00000000-0000-0000-0000-00000000bad1';
const GL_BANK_B = '00000000-0000-0000-0000-00000000bad2';
const GL_BANK_A_INACTIVE = '00000000-0000-0000-0000-00000000bad3';
// A non-bank asset account, to prove account_subtype is actually filtered on.
const GL_DEBTORS_A = '00000000-0000-0000-0000-00000000bad4';

const CUSTOMER_A = '00000000-0000-0000-0000-00000000bac0';
const SUPPLIER_A = '00000000-0000-0000-0000-00000000ba50';

const CASH_A = 1500.25;
const CASH_B = -400.5;
// Held on COMPANY_A's DEACTIVATED bank account. This IS reported: see the
// group cash tests below.
const CASH_A_INACTIVE = 88888;
// Held on a non-bank (debtors) account. This is NOT reported.
const DEBTORS_DECOY_A = 99999;
const EXPECTED_CASH_A = CASH_A + CASH_A_INACTIVE;
// One open invoice each, part-paid, plus a settled one that must be excluded.
const AR_A = 1000 - 250;
const AP_A = 500 - 100;

describe('bank accounts resolve through gl_accounts, not the vestigial bank_accounts table', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'BA Fixture A', true), ($2, 'BA Fixture B', true)
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY_A, COMPANY_B]
    );

    await admin.query(
      `INSERT INTO gl_accounts
         (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES
         ($1, $2, 'BA-1100', 'BA Fixture Cheque A', 'asset', 'bank',    'debit', true),
         ($3, $4, 'BA-1100', 'BA Fixture Cheque B', 'asset', 'bank',    'debit', true),
         ($5, $2, 'BA-1101', 'BA Fixture Closed A', 'asset', 'bank',    'debit', false),
         ($6, $2, 'BA-1200', 'BA Fixture Debtors',  'asset', 'debtors', 'debit', true)
       ON CONFLICT (id) DO NOTHING`,
      [GL_BANK_A, COMPANY_A, GL_BANK_B, COMPANY_B, GL_BANK_A_INACTIVE, GL_DEBTORS_A]
    );

    await admin.query(
      `INSERT INTO company_groups (id, name, is_active) VALUES ($1, 'BA Fixture Group', true)
       ON CONFLICT (id) DO NOTHING`,
      [GROUP]
    );
    await admin.query(
      `INSERT INTO company_group_members (group_id, company_id, is_holding)
       SELECT $1, v.cid, v.holding
       FROM (VALUES ($2::UUID, true), ($3::UUID, false)) AS v(cid, holding)
       WHERE NOT EXISTS (
         SELECT 1 FROM company_group_members WHERE group_id = $1 AND company_id = v.cid
       )`,
      [GROUP, COMPANY_A, COMPANY_B]
    );

    // Cash position is SUM(bank_transactions.amount) over bank-subtype GL
    // accounts, matching kpiDashboardService and bankAccountStatusService.
    await admin.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES
         ($1, $2, CURRENT_DATE, $5, 'BA Fixture inflow A',  'imported'),
         ($3, $4, CURRENT_DATE, $6, 'BA Fixture outflow B', 'imported'),
         -- Two accounts that are NOT plain active bank accounts, and they are
         -- treated differently on purpose.
         --
         -- account_subtype is still load-bearing: the debtors row must never
         -- reach a cash figure, because a receivable is not cash.
         --
         -- is_active is NOT a filter any more, and this row is the assertion
         -- of that. It used to be a decoy pinning the opposite rule. The rule
         -- changed: is_active is a chart-of-accounts PICKER flag meaning "stop
         -- offering this account when coding new transactions", and it says
         -- nothing about whether the account still holds money. Filtering on it
         -- made deactivated accounts vanish from cash, the AFS and the close
         -- checks -- four production accounts held R137,317.39 that no report
         -- would show. So a deactivated bank account's balance IS reported, and
         -- deactivating an account that holds money is now refused outright
         -- (chartOfAccountsService.updateAccount / deleteAccount).
         ($1, $7, CURRENT_DATE, ${DEBTORS_DECOY_A}, 'BA Fixture debtors decoy',  'imported'),
         ($1, $8, CURRENT_DATE, ${CASH_A_INACTIVE}, 'BA Fixture inactive bank', 'imported')`,
      [COMPANY_A, GL_BANK_A, COMPANY_B, GL_BANK_B, CASH_A, CASH_B, GL_DEBTORS_A, GL_BANK_A_INACTIVE]
    );

    // AR / AP fixtures. Outstanding is total_amount - amount_paid over the
    // shared open-status allowlists; 'paid' and 'draft' must be excluded.
    await admin.query(
      `INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'BA Fixture Customer')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_A, COMPANY_A]
    );
    await admin.query(
      `INSERT INTO suppliers (id, company_id, name) VALUES ($1, $2, 'BA Fixture Supplier')
       ON CONFLICT (id) DO NOTHING`,
      [SUPPLIER_A, COMPANY_A]
    );
    await admin.query(
      `INSERT INTO customer_invoices
         (company_id, customer_id, invoice_number, status, total_amount, subtotal, amount_paid, created_by)
       VALUES
         ($1, $2, 'BA-AR-OPEN', 'sent', 1000, 1000, 250, 'fixture'),
         ($1, $2, 'BA-AR-PAID', 'paid', 9999, 9999, 9999, 'fixture'),
         -- A cancelled invoice that was never paid still has
         -- total_amount - amount_paid > 0, so only the status allowlist keeps it
         -- out of AR. A zero-outstanding 'paid' row cannot prove that.
         ($1, $2, 'BA-AR-CANCELLED', 'cancelled', 5000, 5000, 0, 'fixture')`,
      [COMPANY_A, CUSTOMER_A]
    );
    await admin.query(
      `INSERT INTO supplier_invoices
         (company_id, supplier_id, invoice_number, invoice_date, status, total_amount, subtotal, amount_paid, created_by)
       VALUES
         ($1, $2, 'BA-AP-OPEN',  CURRENT_DATE, 'approved', 500,  500,  100, '00000000-0000-0000-0000-000000000000'),
         ($1, $2, 'BA-AP-DRAFT', CURRENT_DATE, 'draft',    7777, 7777, 0,   '00000000-0000-0000-0000-000000000000')`,
      [COMPANY_A, SUPPLIER_A]
    );
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM bank_transactions WHERE company_id = ANY($1::UUID[])`, [[COMPANY_A, COMPANY_B]]);
    await admin.query(`DELETE FROM customer_invoices WHERE company_id = ANY($1::UUID[])`, [[COMPANY_A, COMPANY_B]]);
    await admin.query(`DELETE FROM supplier_invoices WHERE company_id = ANY($1::UUID[])`, [[COMPANY_A, COMPANY_B]]);
    await admin.query(`DELETE FROM customers WHERE company_id = ANY($1::UUID[])`, [[COMPANY_A, COMPANY_B]]);
    await admin.query(`DELETE FROM suppliers WHERE company_id = ANY($1::UUID[])`, [[COMPANY_A, COMPANY_B]]);
    await admin.query(`DELETE FROM company_group_members WHERE group_id = $1`, [GROUP]);
    await admin.query(`DELETE FROM company_groups WHERE id = $1`, [GROUP]);
    await admin.query(`DELETE FROM gl_accounts WHERE company_id = ANY($1::UUID[])`, [[COMPANY_A, COMPANY_B]]);
    await admin.query(`DELETE FROM companies WHERE id = ANY($1::UUID[])`, [[COMPANY_A, COMPANY_B]]);
    await admin.end();
  });

  describe('custom report on bank_transactions', () => {
    it('runs without a 42703 undefined_column error and names the GL bank account', async () => {
      const result = await runReport(COMPANY_A, {
        dataSource: 'bank_transactions',
        columns: [{ field: 'amount' }, { field: 'bank_account' }],
      } as Parameters<typeof runReport>[1]);

      // Three transactions belong to COMPANY_A. The report is not filtered by
      // account_subtype, so all three come back, each named by its GL account.
      expect(result.rowCount).toBe(3);
      expect(new Set(result.rows.map(r => r.bank_account))).toEqual(
        new Set(['BA Fixture Cheque A', 'BA Fixture Debtors', 'BA Fixture Closed A'])
      );
    });

    it('does not name another tenant GL account when a row points across companies', async () => {
      // bank_account_id's FK targets gl_accounts(id) alone, so this row is
      // legal at the DB level: it belongs to COMPANY_A but points at
      // COMPANY_B's bank account. The join must not surface B's account name.
      await admin.query(
        `INSERT INTO bank_transactions
           (company_id, bank_account_id, transaction_date, amount, description, status)
         VALUES ($1, $2, CURRENT_DATE, 12.34, 'BA Fixture cross-tenant pointer', 'imported')`,
        [COMPANY_A, GL_BANK_B]
      );
      try {
        const result = await runReport(COMPANY_A, {
          dataSource: 'bank_transactions',
          columns: [{ field: 'amount' }, { field: 'bank_account' }],
        } as Parameters<typeof runReport>[1]);

        const leaked = result.rows.filter(r => r.bank_account === 'BA Fixture Cheque B');
        expect(leaked).toHaveLength(0);
        // The row itself still appears — only the foreign account name is withheld.
        expect(result.rows.some(r => Number(r.amount) === 12.34 && r.bank_account === null)).toBe(true);
      } finally {
        await admin.query(
          `DELETE FROM bank_transactions WHERE company_id = $1 AND bank_account_id = $2`,
          [COMPANY_A, GL_BANK_B]
        );
      }
    });

    it('scopes rows to the requesting company', async () => {
      const result = await runReport(COMPANY_B, {
        dataSource: 'bank_transactions',
        columns: [{ field: 'amount' }, { field: 'bank_account' }],
      } as Parameters<typeof runReport>[1]);

      expect(result.rowCount).toBe(1);
      expect(result.rows[0]?.bank_account).toBe('BA Fixture Cheque B');
    });
  });

  describe('group combined cash position', () => {
    it('reports each entity real cash, not zero', async () => {
      const stats = await getGroupDashboardStats(GROUP);

      const a = stats.entitySummaries.find(e => e.companyId === COMPANY_A);
      const b = stats.entitySummaries.find(e => e.companyId === COMPANY_B);

      expect(a?.cashPosition).toBeCloseTo(EXPECTED_CASH_A, 2);
      expect(b?.cashPosition).toBeCloseTo(CASH_B, 2);
    });

    it('includes a DEACTIVATED bank account balance — is_active must not hide money', async () => {
      const stats = await getGroupDashboardStats(GROUP);
      const a = stats.entitySummaries.find(e => e.companyId === COMPANY_A);

      // The whole point: without the inactive account this would be CASH_A.
      expect(a?.cashPosition).toBeCloseTo(CASH_A + CASH_A_INACTIVE, 2);
      expect(a?.cashPosition).not.toBeCloseTo(CASH_A, 2);
    });

    it('still excludes a non-bank account — account_subtype stays load-bearing', async () => {
      const stats = await getGroupDashboardStats(GROUP);
      const a = stats.entitySummaries.find(e => e.companyId === COMPANY_A);

      // The debtors decoy dwarfs every other figure, so any leak is obvious.
      expect(a?.cashPosition).toBeLessThan(DEBTORS_DECOY_A);
      expect(a?.cashPosition).not.toBeCloseTo(EXPECTED_CASH_A + DEBTORS_DECOY_A, 2);
    });

    it('combines cash across the group', async () => {
      const stats = await getGroupDashboardStats(GROUP);

      expect(stats.combinedCashPosition).toBeCloseTo(EXPECTED_CASH_A + CASH_B, 2);
    });

    it('sums outstanding AR and AP from total_amount - amount_paid, excluding settled and draft invoices', async () => {
      const stats = await getGroupDashboardStats(GROUP);

      expect(stats.combinedARTotal).toBeCloseTo(AR_A, 2);
      expect(stats.combinedAPTotal).toBeCloseTo(AP_A, 2);
    });
  });

  describe('countBankAccounts', () => {
    it('counts active bank-subtype GL accounts', async () => {
      // COMPANY_A owns three GL accounts: one active bank, one inactive bank,
      // one active debtors. Only the active bank counts.
      //
      // This one KEEPS its is_active filter while the cash figures above drop
      // theirs, and the difference is the question being asked. This backs the
      // setup-guide task "has this company set up a bank account?" -- a
      // configuration check about whether a usable account exists, not a
      // balance. A deactivated account must not mark that task complete.
      expect(await countBankAccounts(COMPANY_A)).toBe(1);
    });

    it('returns zero for a company with no bank account', async () => {
      expect(await countBankAccounts('00000000-0000-0000-0000-00000000dead')).toBe(0);
    });
  });
});
