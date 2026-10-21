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
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { withSavepoint } from '@/lib/neon';
import type { SagePull } from '@/modules/accounting/services/sage/sageApiTypes';
import { markPullReady, readTakeOnContext, startPull, summarise } from '@/modules/accounting/services/sage/sageTakeOnStore';
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

/** Store `pull` as a ready review, as the pull job does. */
async function storeReady(companyId: string, userId: string, pull: SagePull): Promise<string> {
  const pullId = await startPull(companyId, userId, pull.company.id, pull.asAtDate);
  const summary = summarise(buildSageTakeOn(pull, await readTakeOnContext(companyId)));
  expect(await markPullReady(companyId, pullId, pull, summary)).toBe(true);
  return pullId;
}

/** As the import route runs it: a refusal rolls the savepoint back, then the request commits its 400. */
const importAsRoute = (companyId: string, userId: string, pullId: string) =>
  withSavepoint('sage_import_test', () => importSagePull(companyId, userId, pullId));

const balanceOf = async (c: PoolClient, companyId: string, where: string, params: unknown[] = []) => Number((await c.query(
  `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS b
     FROM gl_journal_lines l
     JOIN gl_accounts a ON a.id = l.gl_account_id AND a.company_id = $1
     JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.company_id = $1
    WHERE l.company_id = $1 AND e.status = 'posted' AND ${where}`, [companyId, ...params],
)).rows[0]!.b);

/** Everything a take-on writes, counted, so a refusal can be shown to have written none of it. */
async function books(c: PoolClient, companyId: string) {
  const count = async (table: string) => Number((await c.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE company_id = $1`, [companyId])).rows[0]!.n);
  return {
    accounts: await count('gl_accounts'),
    customers: await count('customers'),
    suppliers: await count('suppliers'),
    journals: await count('gl_journal_entries'),
    lines: await count('gl_journal_lines'),
    sessions: await count('migration_sessions'),
    customerInvoices: await count('customer_invoices'),
    supplierInvoices: await count('supplier_invoices'),
    accountNames: (await c.query('SELECT string_agg(account_code || account_name, \',\' ORDER BY account_code) AS s FROM gl_accounts WHERE company_id = $1', [companyId])).rows[0]!.s as string,
  };
}

const statusOf = async (c: PoolClient, pullId: string) =>
  (await c.query('SELECT status, pull IS NOT NULL AS has_pull FROM sage_connect_pulls WHERE id = $1', [pullId])).rows[0];

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
      expect(await books(c, companyId)).toEqual(after);
      expect(bank).toBeCloseTo(50000, 2);
      expect(await balanceOf(c, companyId, "a.account_name = 'Bank - Cheque'")).toBeCloseTo(50000, 2);
      expect(await statusOf(c, second)).toMatchObject({ status: 'ready', has_pull: true });
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

  it('a chart-of-accounts row the database refuses refuses the import, nothing written', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      const pull = sageFixture();
      // gl_accounts.account_name is VARCHAR(100): the COA step cannot write this row.
      pull.accounts.find((a) => a.ID === 2003)!.Name = `Rent ${'x'.repeat(120)}`;
      pull.trialBalance.find((l) => l.AccountId === 2003)!.Name = pull.accounts.find((a) => a.ID === 2003)!.Name;
      const pullId = await storeReady(companyId, userId, pull);
      const before = await books(c, companyId);

      await expect(importAsRoute(companyId, userId, pullId)).rejects.toThrow();

      expect(await books(c, companyId)).toEqual(before);
      expect(await statusOf(c, pullId)).toMatchObject({ status: 'ready', has_pull: true });
    });
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
