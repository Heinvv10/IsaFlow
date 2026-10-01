// tests/integration/w2-28-coa-import-role-lock.int.test.ts
//
// W2-28 round 3. The COA import's role map rewrites system-account flags, the
// same rows a Default Accounts save rewrites. Both now take the per-company
// role-write advisory lock (systemRoleWriteLock) first, so neither can re-flag
// roles between the other's read and write. Proven by outcome: while another
// transaction holds that lock, the import does not finish; once it commits, the
// import runs to completion.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { importChartOfAccounts, type AccountImportRow } from '@/modules/accounting/services/core/migrationCoaService';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const ROWS = [
  ['1000', 'Bank', 'asset', 'debit'], ['1100', 'AR', 'asset', 'debit'], ['2100', 'AP', 'liability', 'credit'],
  ['1140', 'VAT Input', 'asset', 'debit'], ['2120', 'VAT Output', 'liability', 'credit'],
  ['3200', 'RE', 'equity', 'credit'], ['4000', 'Sales', 'revenue', 'credit'],
  ['6000', 'Expense', 'expense', 'debit'], ['6100', 'Admin', 'expense', 'debit'],
].map(([accountCode, accountName, accountType, normalBalance]) =>
  ({ accountCode, accountName, accountType, normalBalance }) as unknown as AccountImportRow);
const MAP = {
  bank: '1000', receivable: '1100', payable: '2100', vat_input: '1140', vat_output: '2120',
  retained_earnings: '3200', default_revenue: '4000', default_expense: '6000', admin_expense: '6100',
};

describeIfDb('W2-28 — the COA import waits for the role-write lock', () => {
  let fx: Fixture;

  beforeAll(async () => {
    assertDisposable();
    fx = await seedFixture('W228coa', DATABASE_URL!);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`w228coa-${fx.userId}@isaflow.test`}, 'admin', true)`;
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    clearSystemAccountCache(fx.companyId);
    await sql`DELETE FROM migration_sessions WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
    await sql`DELETE FROM users WHERE id = ${fx.userId}`;
  }, 120000);

  it('does not finish while another transaction holds the lock, and completes once it commits', async () => {
    const session = await createSession(fx.companyId, 'sage', fx.userId);
    const holder = await fx.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1::TEXT, 0))', [`default-accounts:${fx.companyId}`]);
      let settled = false;
      const run = inTx(fx, () => importChartOfAccounts(fx.companyId, session.id, ROWS, MAP as never))
        .finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 1000));
      expect(settled, 'the import ran while the role-write lock was held').toBe(false);
      await holder.query('COMMIT');
      const out = await run;
      expect(out.errors).toEqual([]);
      expect(out.imported).toBe(ROWS.length);
    } finally {
      await holder.query('ROLLBACK'); // no-op after the COMMIT; frees the lock if an assertion failed first
      holder.release();
    }
  }, 30000);
});
