/**
 * Audit WP2 row 7 — a typed bank transfer and a manual bank transaction are idempotent under an `Idempotency-Key`.
 * A double-click or a retry used to post the journal twice. The same key now answers the FIRST result (status and
 * body) with no second journal, a concurrent duplicate posts one, and the key on a different body is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { bankCompany, cleanupBankControlsA, type BankCompany } from './bank-controls-a.helpers';
import bankTransfers from '../../pages/api/accounting/bank-transfers';
import bankManual from '../../pages/api/accounting/bank-transactions-manual';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let f: BankCompany;

beforeAll(async () => {
  a = await createUser(pool, tokens);
  f = await bankCompany(pool, [[a, 'admin']], companies);
});
afterAll(async () => {
  await pool.query('DELETE FROM http_idempotency_keys WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a]); // ends the pool
});

const key = () => crypto.randomUUID();
const transferBody = (o: Record<string, unknown> = {}) =>
  ({ fromAccountId: f.bank, toAccountId: f.bank2, amount: 100, transferDate: '2026-09-01', reference: 'IDEM', ...o });
const manualBody = (o: Record<string, unknown> = {}) => ({
  type: 'spend', bankAccountId: f.bank, date: '2026-09-01', amount: 50, allocationType: 'account',
  contraAccountId: f.expA, reference: 'IDEM', description: 'IDEM', ...o,
});
const transfer = (body: Record<string, unknown>, k?: string) => callRoute(bankTransfers, tokens[a]!, f.c, 'POST', body,
  '/api/accounting/bank-transfers', {}, k ? { 'idempotency-key': k } : {});
const manual = (body: Record<string, unknown>, k?: string) => callRoute(bankManual, tokens[a]!, f.c, 'POST', body,
  '/api/accounting/bank-transactions-manual', {}, k ? { 'idempotency-key': k } : {});
const journals = async () => (await pool.query(
  'SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [f.c])).rows[0].n as number;
const answer = (r: { state: { statusCode: number; body: unknown } }) => ({ status: r.state.statusCode, body: r.state.body });

const routes = [
  { name: 'bank-transfers', send: transfer, body: transferBody, other: { amount: 101 }, ok: 200 },
  { name: 'bank-transactions-manual', send: manual, body: manualBody, other: { amount: 51 }, ok: 201 },
] as const;

describe.each(routes)('$name: Idempotency-Key', ({ send, body, other, ok }) => {
  it('the same key twice: one journal, and the second answer is the first, status and body', async () => {
    const k = key();
    const before = await journals();
    const first = await send(body({ reference: 'IDEM-SAME' }), k);
    expect(first.state.statusCode, JSON.stringify(first.state.body)).toBe(ok);
    const again = await send(body({ reference: 'IDEM-SAME' }), k);
    expect(answer(again)).toEqual(answer(first));
    expect((await journals()) - before).toBe(1);
  });

  it('two concurrent requests with one key: one journal, both answered the same', async () => {
    const k = key();
    const before = await journals();
    const [x, y] = await Promise.all([send(body({ reference: 'IDEM-RACE' }), k), send(body({ reference: 'IDEM-RACE' }), k)]);
    expect([x.state.statusCode, y.state.statusCode]).toEqual([ok, ok]);
    expect(answer(x)).toEqual(answer(y));
    expect((await journals()) - before).toBe(1);
  });

  it('the same key on a different body is refused 422 and posts nothing', async () => {
    const k = key();
    const first = await send(body({ reference: 'IDEM-DIFF' }), k);
    expect(first.state.statusCode).toBe(ok);
    const before = await journals();
    const second = await send(body({ reference: 'IDEM-DIFF', ...other }), k);
    expect(second.state.statusCode).toBe(422);
    expect(await journals()).toBe(before);
  });

  it('a refused request does not burn its key: fix the form, resend under the same key', async () => {
    const k = key();
    const before = await journals();
    const bad = await send(body({ reference: 'IDEM-FIX', amount: -5 }), k); // schema refusal, before the claim
    expect(bad.state.statusCode).toBe(422);
    const refused = await send(body({ reference: 'IDEM-FIX', contraAccountId: crypto.randomUUID(), toAccountId: crypto.randomUUID() }), k);
    expect(refused.state.statusCode).toBeGreaterThanOrEqual(400);
    const good = await send(body({ reference: 'IDEM-FIX' }), k);
    expect(good.state.statusCode, JSON.stringify(good.state.body)).toBe(ok);
    expect((await journals()) - before).toBe(1);
    expect((await pool.query('SELECT COUNT(*)::INT AS n FROM http_idempotency_keys WHERE company_id = $1 AND idempotency_key = $2',
      [f.c, k])).rows[0].n).toBe(1);
  });

  it('a malformed key is a 422 and nothing runs', async () => {
    const before = await journals();
    const res = await send(body({ reference: 'IDEM-BAD' }), 'not-a-uuid');
    expect(res.state.statusCode).toBe(422);
    expect(await journals()).toBe(before);
  });
});

describe('without a key the routes behave as before', () => {
  it('manual transactions: two identical requests post two journals', async () => {
    const before = await journals();
    await manual(manualBody({ reference: 'IDEM-NOKEY' }));
    await manual(manualBody({ reference: 'IDEM-NOKEY' }));
    expect((await journals()) - before).toBe(2);
  });
});
