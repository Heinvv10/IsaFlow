/**
 * Connect to Sage on real PostgreSQL — the guards around a take-on, split out
 * of sage-connect-takeon.int.test.ts: IsaFlow's fiscal year comes from its
 * fiscal_periods (R2), and sage_connect_pulls is under active-company RLS.
 * Everything runs in one transaction that is rolled back.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SageImportRefused } from '@/modules/accounting/services/sage/sageTakeOnImportService';
import { getChangesInEquity } from '@/modules/accounting/services/afs/changesInEquityService';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageFixture } from '../unit/services/sage/sageFixture';
import {
  balanceOf, importAsRoute, inRolledBackCompany as inCompany, storeReady,
} from './sage-connect-takeon.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
afterAll(() => pool.end());
const inRolledBackCompany = (fn: Parameters<typeof inCompany>[1], yearStart?: string | null) => inCompany(pool, fn, yearStart);

describe('R2: the fiscal year comes from fiscal_periods', () => {
  // Round 4 (Hein): periods January to December against Sage's March year is
  // taken on balance-sheet-only, not refused. Fixture: profit to date 38 000
  // (income 60 000 - bank charges 2 000 - rent 20 000); Sage's Retained Income
  // is a debit of 15 000, so Retained Earnings ends at a credit of 23 000.
  it('a company whose periods run January to December is taken on balance-sheet-only: profit to date into Retained Earnings', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      const pullId = await storeReady(companyId, userId, sageFixture());
      const outcome = await importAsRoute(companyId, userId, pullId);
      expect(outcome.sessionId).toBeTruthy();

      expect(await balanceOf(c, companyId, 'true')).toBeCloseTo(0, 2); // the ledger balances
      expect(await balanceOf(c, companyId, "a.account_type IN ('revenue', 'expense')")).toBeCloseTo(0, 2); // no P&L before cut-over
      expect(await balanceOf(c, companyId, "a.account_subtype = 'retained_earnings' AND a.is_system_account")).toBeCloseTo(15000 - 38000, 2);
      expect(await balanceOf(c, companyId, "a.account_name = 'Bank - Cheque'")).toBeCloseTo(50000, 2);
      expect(await balanceOf(c, companyId, "a.account_subtype = 'receivable' AND a.is_system_account")).toBeCloseTo(30000, 2);
      expect(await balanceOf(c, companyId, "a.account_subtype = 'opening_balance_equity'")).toBeCloseTo(2000, 2);
    }, '2026-01-01');
  });

  // Round 5: the statement of changes in equity reads the take-on as balances
  // taken on — not as a R23 000 dividend — and still shows a real dividend as one.
  it('the SoCE shows the folded take-on as balances taken on, and a real dividend as a dividend', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      const pullId = await storeReady(companyId, userId, sageFixture());
      await importAsRoute(companyId, userId, pullId);
      const ids = Object.fromEntries((await c.query(
        "SELECT account_subtype, id FROM gl_accounts WHERE company_id = $1 AND is_system_account AND account_subtype IN ('retained_earnings', 'bank')", [companyId],
      )).rows.map((r) => [r.account_subtype, r.id]));
      const dividend = await createJournalEntry(companyId, {
        entryDate: '2026-11-15', description: 'Dividend declared and paid', source: 'manual',
        lines: [{ glAccountId: ids.retained_earnings, debit: 5000, credit: 0 }, { glAccountId: ids.bank, debit: 0, credit: 5000 }],
      }, userId);
      await postJournalEntry(companyId, dividend.id, userId);

      const soce = await getChangesInEquity(companyId, '2026-01-01', '2026-12-31');
      const re = soce.columns.find((col) => col.subtype === 'retained_earnings')!;
      expect(re.takeOn).toBeCloseTo(23000, 2); // -15 000 prior + 38 000 profit to date, credit-positive
      expect(re.dividends).toBeCloseTo(-5000, 2);
      expect(re.profitForYear).toBeCloseTo(0, 2); // no P&L before the cut-over
      // The statement still ties to the ledger's equity.
      const equity = -(await balanceOf(c, companyId, "a.account_type = 'equity'"));
      expect(soce.totalClosing).toBeCloseTo(equity, 2);
    }, '2026-01-01');
  });

  it('a company with no fiscal period for the cut-over date is refused with what to do', async () => {
    await inRolledBackCompany(async (_c, companyId, userId) => {
      const pullId = await storeReady(companyId, userId, sageFixture());
      const err = await importAsRoute(companyId, userId, pullId).then(() => null, (e: unknown) => e);
      expect((err as SageImportRefused).issues).toContainEqual(expect.objectContaining({
        area: 'company', message: expect.stringContaining('no fiscal period covering 2026-10-21'),
      }));
    }, null);
  });
});

describe('sage_connect_pulls under RLS (app_user, the routes\' role)', () => {
  it('a member working in one company sees and writes only that company\'s Sage reads, even another company they belong to', async () => {
    await inRolledBackCompany(async (c, companyA, userId) => {
      const companyB = randomUUID();
      await c.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyB, 'Sage connect take-on B']);
      await c.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [companyB, userId]);
      const insert = (co: string) => c.query(
        "INSERT INTO sage_connect_pulls (company_id, created_by, sage_company_id, as_at_date) VALUES ($1, $2, 1, '2026-10-21') RETURNING id", [co, userId]);
      await insert(companyA);
      const rowB = (await insert(companyB)).rows[0]!.id as string;

      await c.query('SAVEPOINT rls');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [companyA]);
      const seen = (await c.query('SELECT company_id FROM sage_connect_pulls')).rows.map((r) => r.company_id);
      expect(seen).toEqual([companyA]);
      expect((await c.query("UPDATE sage_connect_pulls SET status = 'discarded' WHERE id = $1", [rowB])).rowCount).toBe(0);
      await expect(insert(companyB)).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK TO SAVEPOINT rls');
      await expect(c.query('SAVEPOINT del; SET LOCAL ROLE app_user; DELETE FROM sage_connect_pulls')).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK TO SAVEPOINT del');
    });
  });
});
