/**
 * WP2 row 1 (audit 2026-11-15): `bankAccountId` from a request body named the
 * bank of what the route wrote, and three routes took ANY id — a revenue
 * account became "the bank" of a manual line, of a classified import and of a
 * reconciliation. `assertBankAccountInCompany` (bank/bankAccountGuard) now
 * refuses, before the first write, every id that is not an active bank account
 * of the request's company: 400, and nothing written in either company. A
 * credit card (a liability with a bank subtype) is still a bank account.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import manualRoute from '../../pages/api/accounting/bank-transactions-manual';
import classifiedRoute from '../../pages/api/accounting/bank-transactions-import-classified';
import reconciliationsRoute from '../../pages/api/accounting/bank-reconciliations';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { cleanupGuardFixture, guardFixture, messageOf, refusedIds, writtenRows, type GuardFixture } from './bank-account-guard.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let x: GuardFixture;

beforeAll(async () => {
  x = await guardFixture(pool);
});
afterAll(() => cleanupGuardFixture(pool, x));

const post = (route: unknown, body: Record<string, unknown>, url: string) =>
  callRoute(route as never, x.tokens[x.user]!, x.f.c, 'POST', body, url);

const manual = (bankAccountId: string) => post(manualRoute, {
  type: 'spend', bankAccountId, date: '2026-09-10', amount: 115, allocationType: 'account', contraAccountId: x.f.expA,
  description: 'BAG manual',
}, '/api/accounting/bank-transactions-manual');

const classified = (bankAccountId: string, tag: string) => post(classifiedRoute, {
  bankAccountId, transactions: [{ transactionDate: '2026-09-04', description: `BAG classified ${tag}`, debit: 77 }],
}, '/api/accounting/bank-transactions-import-classified');

const reconcile = (bankAccountId: string) => post(reconciliationsRoute, {
  bankAccountId, statementDate: '2026-09-30', statementBalance: 0,
}, '/api/accounting/bank-reconciliations');

/** Every refused id answers 400 naming the refusal, and writes nothing anywhere. */
async function expectRefusedEverywhere(call: (id: string) => Promise<{ state: { statusCode: number; body: unknown } }>) {
  for (const [what, id] of refusedIds(x)) {
    const before = await writtenRows(pool, x);
    const res = await call(id);
    expect(res.state.statusCode, `${what}: ${JSON.stringify(res.state.body)}`).toBe(400);
    expect(messageOf(res), what).toMatch(/bank account/i);
    expect(await writtenRows(pool, x), `${what} wrote a row`).toEqual(before);
  }
}

describe('bank-transactions-manual: the bank of a hand-keyed line', () => {
  it('refuses a revenue account, a foreign bank account and an inactive bank account: 400, nothing written', async () => {
    await expectRefusedEverywhere((id) => manual(id));
  });

  it('still records and allocates a line on a real bank account, and on a credit card', async () => {
    for (const bank of [x.f.bank, x.creditCard]) {
      const res = await manual(bank);
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
      const id = (res.state.body as { data: { bankTransactionId: string } }).data.bankTransactionId;
      const { rows: [row] } = await pool.query(
        'SELECT bank_account_id, status FROM bank_transactions WHERE id = $1 AND company_id = $2', [id, x.f.c]);
      expect(row).toEqual({ bank_account_id: bank, status: 'allocated' });
    }
  });
});

describe('bank-transactions-import-classified: the bank of an imported worksheet', () => {
  it('refuses a revenue account, a foreign bank account and an inactive bank account: 400, nothing written', async () => {
    await expectRefusedEverywhere((id) => classified(id, id.slice(0, 8)));
  });

  it('refuses an id that is no account at all with the same 400', async () => {
    const res = await classified(crypto.randomUUID(), 'none');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
  });

  it('still imports into a real bank account', async () => {
    const res = await classified(x.f.bank, 'ok');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    const { batchId } = (res.state.body as { data: { batchId: string } }).data;
    const { rows } = await pool.query(
      'SELECT bank_account_id FROM bank_transactions WHERE import_batch_id = $1 AND company_id = $2', [batchId, x.f.c]);
    expect(rows).toEqual([{ bank_account_id: x.f.bank }]);
  });
});

describe('bank-reconciliations POST: the bank a reconciliation session reconciles', () => {
  it('refuses a revenue account, a foreign bank account and an inactive bank account: 400, nothing written', async () => {
    await expectRefusedEverywhere((id) => reconcile(id));
  });

  it('still starts a reconciliation of a real bank account', async () => {
    const res = await reconcile(x.f.bank2);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    const { rows } = await pool.query(
      'SELECT bank_account_id FROM bank_reconciliations WHERE company_id = $1', [x.f.c]);
    expect(rows).toEqual([{ bank_account_id: x.f.bank2 }]);
  });
});

// Round 3 (brk-1449 MEDIUM, measured): the guard's FOR SHARE waited UNBOUNDED behind an open chart edit of the account
// (no lock_timeout on app_user, the pool or the database). It is bounded at 5 s, tighten-only, and answered 503.
describe('a chart edit holding the bank account: the guard waits at most 5 s, then 503 and nothing written', () => {
  const sleep = (ms: number) => new Promise<null>((r) => { setTimeout(() => r(null), ms); });
  for (const [what, call] of [
    ['bank-transactions-manual', () => manual(x.f.bank)],
    ['bank-transactions-import-classified (its catch-all no longer turns it into a 400)', () => classified(x.f.bank, 'held')],
  ] as const) {
    it(what, async () => {
      const writer = await pool.connect();
      await writer.query('BEGIN');
      await writer.query('UPDATE gl_accounts SET account_name = account_name WHERE id = $1', [x.f.bank]);
      const before = await writtenRows(pool, x);
      const t0 = Date.now();
      try {
        const settled = await Promise.race([call().then((res) => ({ res })), sleep(9000)]);
        expect(settled, 'the request was still waiting on the account after 9 s').not.toBeNull();
        const elapsed = Date.now() - t0;
        expect(settled!.res.state.statusCode, JSON.stringify(settled!.res.state.body)).toBe(503);
        expect(elapsed, `answered after ${elapsed} ms`).toBeGreaterThanOrEqual(4500);
        expect(elapsed, `answered after ${elapsed} ms`).toBeLessThan(8000);
        expect(messageOf(settled!.res)).toMatch(/retry/i);
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
      }
      expect(await writtenRows(pool, x)).toEqual(before);
    }, 20_000);
  }
});
