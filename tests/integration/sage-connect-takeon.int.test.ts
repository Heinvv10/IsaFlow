/**
 * Connect to Sage — a whole take-on on real PostgreSQL.
 *
 * A synthetic Sage pull (tests/unit/services/sage/sageFixture) is stored the
 * way the pull job stores it (startPull -> markPullReady) and imported through
 * importSagePull, which drives the migration wizard's own steps. Checked on the
 * ledger itself: the trial balance balances, the AR/AP control accounts equal
 * the Sage balances brought across, documents post no VAT, Opening Balance
 * Equity holds only the difference the review warned about, and a non-current
 * liability lands as a liability.
 *
 * And the refusals, each leaving the books exactly as they were (H1, H3): a
 * second take-on into the same company; one row a wizard step refuses (the
 * all-or-nothing rollback, run in a savepoint as the import route's
 * withJournalDateRefusal runs it); a blocking review issue; a chart-of-accounts
 * row the database refuses.
 *
 * Everything runs in one transaction that is rolled back, so nothing is left
 * behind and no teardown can miss a table.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SageImportRefused, importSagePull } from '@/modules/accounting/services/sage/sageTakeOnImportService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageFixture } from '../unit/services/sage/sageFixture';
import {
  balanceOf, books, importAsRoute, inRolledBackCompany as inCompany, statusOf, storeReady,
} from './sage-connect-takeon.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
afterAll(() => pool.end());
const inRolledBackCompany = (fn: Parameters<typeof inCompany>[1], yearStart?: string | null) => inCompany(pool, fn, yearStart);

import { createSession } from '@/modules/accounting/services/core/migrationService';
import { importOpeningBalances } from '@/modules/accounting/services/core/migrationWizardOpeningBalanceService';

describe('Connect to Sage: importSagePull on a fresh company', () => {
  it('takes the whole company on and the ledger agrees with Sage', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      const pullId = await storeReady(companyId, userId, sageFixture());

      const outcome = await importSagePull(companyId, userId, pullId);

      expect(outcome.steps.customers.imported).toBe(3);
      expect(outcome.steps.suppliers.imported).toBe(2);
      expect(outcome.steps.arInvoices.imported).toBe(3);
      expect(outcome.steps.apInvoices.imported).toBe(1);
      expect(outcome.steps.openingBalances?.journalEntryId).toBeTruthy();

      // The whole ledger balances.
      expect(await balanceOf(c, companyId, 'true')).toBeCloseTo(0, 2);
      // Control accounts equal what was brought across.
      expect(await balanceOf(c, companyId, "a.account_subtype = 'receivable' AND a.is_system_account")).toBeCloseTo(30000, 2);
      expect(await balanceOf(c, companyId, "a.account_subtype = 'payable' AND a.is_system_account")).toBeCloseTo(-27000, 2);
      // Opening Balance Equity holds only the overpaid supplier the review warned about.
      expect(await balanceOf(c, companyId, "a.account_subtype = 'opening_balance_equity'")).toBeCloseTo(2000, 2);
      // Take-on documents post no VAT: VAT output holds only Sage's own VAT balance.
      expect(await balanceOf(c, companyId, "a.account_subtype = 'vat_output' AND a.is_system_account")).toBeCloseTo(-3000, 2);

      const loan = (await c.query(
        "SELECT account_type FROM gl_accounts WHERE company_id = $1 AND account_name = 'Loan - Director'", [companyId],
      )).rows[0];
      expect(loan?.account_type).toBe('liability');

      expect(await statusOf(c, pullId)).toMatchObject({ status: 'imported', has_pull: false });
    });
  });

  it('refuses to import the same review twice', async () => {
    await inRolledBackCompany(async (_c, companyId, userId) => {
      const pullId = await storeReady(companyId, userId, sageFixture());
      await importSagePull(companyId, userId, pullId);
      await expect(importSagePull(companyId, userId, pullId)).rejects.toBeInstanceOf(SageImportRefused);
    });
  });

  it('cannot see or import another company\'s review', async () => {
    await inRolledBackCompany(async (_c, companyId, userId) => {
      const pullId = await storeReady(companyId, userId, sageFixture());
      await expect(importSagePull(randomUUID(), userId, pullId)).rejects.toThrow(/not found/i);
    });
  });
});

describe('Connect to Sage: refusals leave the books as they were', () => {
  it('H1: a second, different pull into the same company is refused and the ledger is unchanged', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      const first = await storeReady(companyId, userId, sageFixture());
      await importSagePull(companyId, userId, first);
      const after = await books(c, companyId);
      const bank = await balanceOf(c, companyId, "a.account_name = 'Bank - Cheque'");

      // A different Sage company with its own document numbers: nothing in it
      // collides with the first import, so without the guard it would land in
      // full and Bank would read R100k instead of R50k.
      const other = sageFixture();
      other.company = { id: 556, name: 'Acme Media — the right one', currencySymbol: 'R' };
      const renumber = (n: string) => `B-${n}`;
      for (const docs of [...Object.values(other.customerDocuments), ...Object.values(other.supplierDocuments)]) {
        for (const d of docs) d.DocumentNumber = renumber(d.DocumentNumber);
      }
      for (const r of [...other.customerInvoices, ...other.supplierInvoices]) r.DocumentNumber = renumber(r.DocumentNumber);
      other.customers = other.customers.map((c) => ({ ...c, ID: c.ID + 100 }));
      other.suppliers = other.suppliers.map((x) => ({ ...x, ID: x.ID + 100 }));
      other.customerDocuments = Object.fromEntries(Object.entries(other.customerDocuments).map(([k, v]) => [Number(k) + 100, v]));
      other.supplierDocuments = Object.fromEntries(Object.entries(other.supplierDocuments).map(([k, v]) => [Number(k) + 100, v]));
      const second = await storeReady(companyId, userId, other);
      const err = await importAsRoute(companyId, userId, second).then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(SageImportRefused);
      expect((err as Error).message).toMatch(/already has its books from Sage/);
      // R4: reversing opening balances cannot reopen a company with an imported pull; the message does not suggest it.
      expect((err as Error).message).not.toMatch(/reverse/i);
      expect((err as Error).message).toMatch(/once per company/);
      expect(await books(c, companyId)).toEqual(after);
      expect(bank).toBeCloseTo(50000, 2);
      expect(await balanceOf(c, companyId, "a.account_name = 'Bank - Cheque'")).toBeCloseTo(50000, 2);
      expect(await statusOf(c, second)).toMatchObject({ status: 'ready', has_pull: true });
    });
  });

  it('R4: opening balances from the file wizard refuse a Sage import, and say how to clear the way', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      const session = await createSession(companyId, 'csv_import', userId);
      const bank = (await c.query("SELECT account_code FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'bank' AND is_system_account LIMIT 1", [companyId])).rows[0]!.account_code as string;
      const equity = (await c.query("SELECT account_code FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'retained_earnings' LIMIT 1", [companyId])).rows[0]!.account_code as string;
      await importOpeningBalances(companyId, session.id, '2026-10-01', [
        { accountCode: bank, debit: 100, credit: 0 }, { accountCode: equity, debit: 0, credit: 100 },
      ], userId);
      const pullId = await storeReady(companyId, userId, sageFixture());
      const err = await importAsRoute(companyId, userId, pullId).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(SageImportRefused);
      expect((err as Error).message).toMatch(/opening balances from a migration \(dated 2026-10-01\).*reverse that opening-balance journal/i);
    });
  });

  it('H3: one row a wizard step refuses rolls the whole import back; the review stays ready', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      const pull = sageFixture();
      // A negative tax leg: the AR step refuses that row (R-119), after the
      // chart, contacts and opening balances have already been written.
      pull.customerDocuments[11]![1]!.Tax = -10;
      const pullId = await storeReady(companyId, userId, pull);
      const before = await books(c, companyId);

      const err = await importAsRoute(companyId, userId, pullId).then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(SageImportRefused);
      expect((err as SageImportRefused).issues).toContainEqual(expect.objectContaining({ severity: 'error', area: 'receivables' }));
      expect(await books(c, companyId)).toEqual(before); // no account, contact, journal, line, session or document left
      expect(await statusOf(c, pullId)).toMatchObject({ status: 'ready', has_pull: true });
    });
  });

  it('a blocking review issue refuses before anything is written', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      const pull = sageFixture();
      pull.trialBalance[0]!.Debit = 50001; // Sage's trial balance no longer balances
      const pullId = await storeReady(companyId, userId, pull);
      const before = await books(c, companyId);

      const err = await importAsRoute(companyId, userId, pullId).then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(SageImportRefused);
      expect((err as SageImportRefused).issues).toContainEqual(expect.objectContaining({ severity: 'error', area: 'trial_balance' }));
      expect(await books(c, companyId)).toEqual(before);
      expect(await statusOf(c, pullId)).toMatchObject({ status: 'ready' });
    });
  });

  it('a chart of accounts the COA step refuses refuses the import, nothing written', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      // The bank role lands on the company's existing bank account, which here
      // has a sub-account: a balance-sheet role holder may not (roleTargetRefusal),
      // so the COA step refuses the role map and imports nothing.
      await c.query(
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, parent_account_id, level)
         SELECT company_id, '1119', 'Bank sub-account', 'asset', 'debit', id, 2 FROM gl_accounts
         WHERE company_id = $1 AND account_subtype = 'bank' AND is_system_account LIMIT 1`, [companyId]);
      const pullId = await storeReady(companyId, userId, sageFixture());
      const before = await books(c, companyId);

      const err = await importAsRoute(companyId, userId, pullId).then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(SageImportRefused);
      expect((err as Error).message).toMatch(/^The chart of accounts could not be imported: .*bank/);
      expect(await books(c, companyId)).toEqual(before);
      expect(await statusOf(c, pullId)).toMatchObject({ status: 'ready', has_pull: true });
    });
  });
});
