/**
 * Connect to Sage — a whole take-on on real PostgreSQL.
 *
 * A synthetic Sage pull (tests/unit/services/sage/sageFixture) is stored and
 * imported through importSagePull, which drives the migration wizard's own
 * steps. Checked on the ledger itself: the trial balance balances, the AR/AP
 * control accounts equal the Sage balances brought across, documents post no
 * VAT, Opening Balance Equity holds only the difference the review warned
 * about, and a non-current liability lands as a liability.
 *
 * Everything runs in one transaction that is rolled back, so nothing is left
 * behind and no teardown can miss a table.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { savePull, summarise, readTakeOnContext } from '@/modules/accounting/services/sage/sageTakeOnStore';
import { importSagePull, SageImportRefused } from '@/modules/accounting/services/sage/sageTakeOnImportService';
import { buildSageTakeOn } from '@/modules/accounting/services/sage/sageTakeOnBuilder';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageFixture } from '../unit/services/sage/sageFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
afterAll(() => pool.end());

async function inRolledBackCompany(fn: (c: PoolClient, companyId: string, userId: string) => Promise<void>) {
  const c = await pool.connect();
  const companyId = randomUUID();
  const userId = randomUUID();
  await c.query('BEGIN');
  try {
    await c.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [userId, `${userId}@test.local`]);
    await c.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyId, 'Sage connect take-on']);
    await c.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [companyId, userId]);
    // A new company gets the seeded chart, as onboarding does.
    await c.query('SELECT public.seed_company_chart_of_accounts($1)', [companyId]);
    await als.run({ client: c, userId, companyId, claims: {} } as never, () => fn(c, companyId, userId));
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const balanceOf = async (c: PoolClient, companyId: string, where: string, params: unknown[] = []) => Number((await c.query(
  `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS b
     FROM gl_journal_lines l
     JOIN gl_accounts a ON a.id = l.gl_account_id AND a.company_id = $1
     JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.company_id = $1
    WHERE l.company_id = $1 AND e.status = 'posted' AND ${where}`, [companyId, ...params],
)).rows[0]!.b);

describe('Connect to Sage: importSagePull on a fresh company', () => {
  it('takes the whole company on and the ledger agrees with Sage', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      const pull = sageFixture();
      const preview = buildSageTakeOn(pull, await readTakeOnContext(companyId));
      const pullId = await savePull(companyId, userId, pull, summarise(preview));

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

      const stored = (await c.query('SELECT status, pull FROM sage_connect_pulls WHERE id = $1', [pullId])).rows[0];
      expect(stored).toMatchObject({ status: 'imported', pull: null });
    });
  });

  it('refuses to import the same review twice', async () => {
    await inRolledBackCompany(async (_c, companyId, userId) => {
      const pull = sageFixture();
      const pullId = await savePull(companyId, userId, pull, summarise(buildSageTakeOn(pull, await readTakeOnContext(companyId))));
      await importSagePull(companyId, userId, pullId);
      await expect(importSagePull(companyId, userId, pullId)).rejects.toBeInstanceOf(SageImportRefused);
    });
  });

  it('cannot see or import another company\'s review', async () => {
    await inRolledBackCompany(async (_c, companyId, userId) => {
      const pull = sageFixture();
      const pullId = await savePull(companyId, userId, pull, summarise(buildSageTakeOn(pull, await readTakeOnContext(companyId))));
      await expect(importSagePull(randomUUID(), userId, pullId)).rejects.toThrow(/not found/i);
    });
  });
});
