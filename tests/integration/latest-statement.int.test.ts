/**
 * bank/latestStatementService.getLatestStatements against a real database —
 * the SQL that picks, per bank account, the latest statement on any
 * reconciliation and the latest COMPLETED one (the GL export's bank_accounts
 * table reads it; its unit test replaces it).
 *
 *  - the latest statement wins whatever its status, and its typed balance
 *    comes with it; the latest completed one is reported beside it
 *  - two sessions on the same statement date: the completed one's balance
 *  - an account with no completed session: lastReconciledDate null
 *  - an account with no session at all: absent
 *  - another company's sessions, on an account of its own, never appear
 *
 * Fixture: l2-credit-note-fifo.helpers (two disposable companies). Sessions by
 * plain SQL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupFixture, type Fixture } from './l2-credit-note-fifo.helpers';
import { getLatestStatements } from '@/modules/accounting/services/bank/latestStatementService';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let f: Fixture;
let other: Fixture;
const acct = { a: '', b: '', c: '', none: '', other: '' };

async function bankAccount(fx: Fixture, code: string): Promise<string> {
  const { rows } = await fx.pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active)
     VALUES($1,$2,$3,'asset','bank','debit',true) RETURNING id`, [fx.company, code, `LST bank ${code}`]);
  return String(rows[0].id);
}

async function session(fx: Fixture, account: string, date: string, balance: number, status: string): Promise<void> {
  await fx.pool.query(
    `INSERT INTO bank_reconciliations(company_id,bank_account_id,statement_date,statement_balance,status,started_by)
     VALUES($1,$2,$3,$4,$5,$6)`, [fx.company, account, date, balance, status, fx.user]);
}

describeIfDb('getLatestStatements', () => {
  beforeAll(async () => {
    f = await setupFixture('LST');
    other = await setupFixture('LST2');
    acct.a = await bankAccount(f, '1001');
    acct.b = await bankAccount(f, '1002');
    acct.c = await bankAccount(f, '1003');
    acct.none = await bankAccount(f, '1004');
    acct.other = await bankAccount(other, '1001');

    await session(f, acct.a, '2026-08-24', 10, 'completed');
    await session(f, acct.a, '2026-09-24', 20, 'completed');
    await session(f, acct.a, '2026-10-24', 30, 'in_progress');
    // Same statement date: the in-progress one entered first, the completed one after.
    await session(f, acct.b, '2026-09-30', 5, 'in_progress');
    await session(f, acct.b, '2026-09-30', 6, 'completed');
    await session(f, acct.c, '2026-07-31', 7, 'in_progress');
    await session(other, acct.other, '2026-12-31', 999, 'completed');
  }, 60000);

  afterAll(async () => {
    for (const fx of [f, other]) {
      if (!fx) continue;
      await fx.pool.query('DELETE FROM bank_reconciliations WHERE company_id = $1', [fx.company]);
      await fx.cleanup();
    }
  }, 60000);

  it('per account: the latest statement (any status) with its balance, and the latest completed date', async () => {
    const got = await getLatestStatements(f.company);
    expect(got.get(acct.a)).toEqual({
      bankAccountId: acct.a, lastStatementDate: '2026-10-24', lastStatementBalance: 30, lastReconciledDate: '2026-09-24',
    });
    expect(got.get(acct.b)).toEqual({
      bankAccountId: acct.b, lastStatementDate: '2026-09-30', lastStatementBalance: 6, lastReconciledDate: '2026-09-30',
    });
    expect(got.get(acct.c)).toEqual({
      bankAccountId: acct.c, lastStatementDate: '2026-07-31', lastStatementBalance: 7, lastReconciledDate: null,
    });
    expect(got.has(acct.none)).toBe(false);
  }, 60000);

  it('reads this company only', async () => {
    const got = await getLatestStatements(f.company);
    expect([...got.keys()].sort()).toEqual([acct.a, acct.b, acct.c].sort());
    expect((await getLatestStatements(other.company)).get(acct.other)?.lastStatementBalance).toBe(999);
  }, 60000);
});
