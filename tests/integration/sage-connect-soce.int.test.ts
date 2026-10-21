/**
 * The statements of changes in equity after an Import from Sage, on
 * PostgreSQL: the report SOCE (changesInEquityService) and the AFS SOCE's
 * dividends paid (fetchDividendsPaid, paidOnly) both read a take-on journal
 * (gl/takeOnJournalSource) as a balance carried in — Retained Earnings,
 * other equity and dividends alike — and agree with each other; a dividend
 * outside a take-on is a dividend in both; a reversed take-on nets to nil on
 * the take-on row; Sage live history (auto_gl_import since migration 908) is
 * an ordinary movement, and a Sage opening balance kept as auto_migration
 * stays a take-on. Everything runs in one transaction that is rolled back.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { getChangesInEquity } from '@/modules/accounting/services/afs/changesInEquityService';
import { fetchDividendsPaid } from '@/modules/accounting/services/afs/noteGenerators/primaryStatements/dividendsPaid';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { importOpeningBalances } from '@/modules/accounting/services/core/migrationWizardOpeningBalanceService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageFixture } from '../unit/services/sage/sageFixture';
import { balanceOf, importAsRoute, inRolledBackCompany as inCompany, storeReady } from './sage-connect-takeon.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
afterAll(() => pool.end());
const inRolledBackCompany = (fn: Parameters<typeof inCompany>[1], yearStart?: string | null) => inCompany(pool, fn, yearStart);

const systemIds = async (c: PoolClient, companyId: string) => Object.fromEntries((await c.query(
  "SELECT account_subtype, id FROM gl_accounts WHERE company_id = $1 AND is_system_account AND account_subtype IN ('retained_earnings', 'bank')", [companyId],
)).rows.map((r) => [r.account_subtype, r.id as string]));

const post = async (companyId: string, userId: string, date: string, description: string, debitId: string, creditId: string, amount: number) => {
  const je = await createJournalEntry(companyId, {
    entryDate: date, description, source: 'manual',
    lines: [{ glAccountId: debitId, debit: amount, credit: 0 }, { glAccountId: creditId, debit: 0, credit: amount }],
  }, userId);
  await postJournalEntry(companyId, je.id, userId);
};

/** A raw journal as the Britech script wrote one (its own entry number, no posting path). */
const rawJournal = async (c: PoolClient, companyId: string, userId: string, number: string, description: string, source: string, debitId: string, creditId: string, amount: number) => {
  const id = (await c.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by)
     VALUES ($1, $2, '2026-11-20', $3, $4, 'posted', $5) RETURNING id`, [companyId, number, description, source, userId],
  )).rows[0]!.id as string;
  await c.query(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES ($1, $2, $3, $5, 0, 'd'), ($1, $2, $4, 0, $5, 'c')`, [companyId, id, debitId, creditId, amount]);
};

describe('changes in equity after Import from Sage', () => {
  it('take-on as balances taken on; real dividend and relabelled history as dividends; a kept Sage O/B stays a take-on', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      await importAsRoute(companyId, userId, await storeReady(companyId, userId, sageFixture()));
      const ids = await systemIds(c, companyId);
      const obEquity = (await c.query(
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, level)
         VALUES ($1, '3999', 'Retained Income (Opening Balance)', 'equity', 'equity', 'credit', 1) RETURNING id`, [companyId],
      )).rows[0]!.id as string;
      await post(companyId, userId, '2026-11-15', 'Dividend declared and paid', ids.retained_earnings!, ids.bank!, 5000);
      // Sage live history, as migration 908 leaves it: an ordinary movement.
      await rawJournal(c, companyId, userId, 'SAGE-77', 'Correction', 'auto_gl_import', ids.retained_earnings!, ids.bank!, 1000);
      // Sage's own opening balance, kept as auto_migration by 908: a take-on, not a share issue.
      await rawJournal(c, companyId, userId, 'SAGE-78', 'O/B from other system', 'auto_migration', ids.bank!, obEquity, 2500);

      const soce = await getChangesInEquity(companyId, '2026-01-01', '2026-12-31');
      const re = soce.columns.find((col) => col.subtype === 'retained_earnings')!;
      expect(re.takeOn).toBeCloseTo(23000, 2); // -15 000 prior + 38 000 profit to date, credit-positive
      expect(re.dividends).toBeCloseTo(-6000, 2);
      const equity = soce.columns.find((col) => col.subtype === 'equity')!;
      expect([equity.takeOn, equity.shareIssue]).toEqual([expect.closeTo(9000 + 2500, 2), 0]); // Sage share capital + the O/B
      expect(soce.totalClosing).toBeCloseTo(-(await balanceOf(c, companyId, "a.account_type = 'equity'")), 2);
    }, '2026-01-01');
  });

  it('dividends in a take-on are taken on in BOTH readers; a dividend after it is a dividend in both', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      const pull = sageFixture();
      pull.accounts.push({ ID: 2010, Name: 'Dividends paid', Category: { ID: 9, Description: 'Owners Equity' }, Active: true, AccountType: 1 });
      pull.trialBalance.push({ AccountId: 2010, Name: 'Dividends paid', Debit: 10000, Credit: 0 });
      pull.trialBalance.find((l) => l.AccountId === 2005)!.Credit = 19000; // share capital, to keep Sage's TB balanced
      await importAsRoute(companyId, userId, await storeReady(companyId, userId, pull));
      const dividends = (await c.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_name = 'Dividends paid'", [companyId])).rows[0]!.id as string;
      await c.query("UPDATE gl_accounts SET account_subtype = 'dividends', normal_balance = 'debit' WHERE id = $1", [dividends]);
      await c.query("INSERT INTO afs_account_mappings(company_id, gl_account_id, afs_line_code) VALUES ($1, $2, 'IS484')", [companyId, dividends]);
      const readers = async () => {
        const re = (await getChangesInEquity(companyId, '2026-03-01', '2027-02-28')).columns.find((col) => col.subtype === 'retained_earnings')!;
        return { report: re.dividends, afs: await fetchDividendsPaid(companyId, '2026-03-01', '2027-02-28', true), takeOn: re.takeOn };
      };

      const taken = await readers();
      expect(taken.afs).toBeCloseTo(0, 2);
      expect(taken.report).toBeCloseTo(-taken.afs, 2);
      // Years match (no fold): Sage's prior Retained Income (a debit of 15 000) and the 10 000 dividends, both carried in.
      expect(taken.takeOn).toBeCloseTo(-15000 - 10000, 2);
      // The balance sheet still has the dividends account's balance, whatever posted it.
      expect(await fetchDividendsPaid(companyId, null, '2027-02-28')).toBeCloseTo(10000, 2);

      const ids = await systemIds(c, companyId);
      await post(companyId, userId, '2026-11-15', 'Dividend paid after cut-over', dividends, ids.bank!, 1000);
      const after = await readers();
      expect(after.afs).toBeCloseTo(1000, 2);
      expect(after.report).toBeCloseTo(-after.afs, 2);
    });
  });

  it('the file wizard\'s opening-balance dividends are taken on in both readers too', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      const ids = await systemIds(c, companyId);
      const dividends = (await c.query(
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, level)
         VALUES ($1, '3450', 'Dividends paid', 'equity', 'dividends', 'debit', 1) RETURNING id`, [companyId],
      )).rows[0]!.id as string;
      await c.query("INSERT INTO afs_account_mappings(company_id, gl_account_id, afs_line_code) VALUES ($1, $2, 'IS484')", [companyId, dividends]);
      const bank = (await c.query('SELECT account_code FROM gl_accounts WHERE id = $1', [ids.bank])).rows[0]!.account_code as string;
      const session = await createSession(companyId, 'csv_import', userId);
      await importOpeningBalances(companyId, session.id, '2026-10-01', [
        { accountCode: '3450', debit: 4000, credit: 0 }, { accountCode: bank, debit: 0, credit: 4000 },
      ], userId);

      const re = (await getChangesInEquity(companyId, '2026-03-01', '2027-02-28')).columns.find((col) => col.subtype === 'retained_earnings')!;
      expect(await fetchDividendsPaid(companyId, '2026-03-01', '2027-02-28', true)).toBeCloseTo(0, 2);
      expect([re.dividends, re.takeOn]).toEqual([0, expect.closeTo(-4000, 2)]);
    });
  });

  it('a reversed take-on nets to nil on the take-on row (the reversal copies the source)', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      await importAsRoute(companyId, userId, await storeReady(companyId, userId, sageFixture()));
      const ob = (await c.query(
        "SELECT id FROM gl_journal_entries WHERE company_id = $1 AND description = 'Opening balances — migration import'", [companyId],
      )).rows[0]!.id as string;
      await reverseJournalEntry(companyId, ob, userId);
      const reversal = (await c.query('SELECT source FROM gl_journal_entries WHERE company_id = $1 AND reversal_of_id = $2', [companyId, ob])).rows[0];
      expect(reversal?.source).toBe('auto_migration');

      const re = (await getChangesInEquity(companyId, '2026-03-01', '2027-02-28')).columns.find((col) => col.subtype === 'retained_earnings')!;
      expect(re.takeOn).toBeCloseTo(0, 2);
      expect(re.dividends).toBeCloseTo(0, 2);
    });
  });
});
