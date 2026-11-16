/**
 * Audit WP2 row 9, round 2 — allocate and split_allocate input refusals are 400, decided BEFORE the first write.
 *
 * `withAuth` COMMITs a 4xx and rolls back a 5xx. A split whose lines do not foot, an unusable cost centre and a
 * contra account of another company used to be plain Errors out of createJournalEntry: answered 500, which is right
 * for a fault but wrong for the user's input. Each is now a BankAllocationRefusal raised before anything is written,
 * so the route answers 400 and the line is untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { actionRoute, bankCompany, cleanupBankControlsA, plantLine, refusalOf, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let f: BankCompany;
let other: BankCompany;
let act: ReturnType<typeof actionRoute>;
let inactiveCc1 = '';
let activeCc2AsCc1 = '';

beforeAll(async () => {
  a = await createUser(pool, tokens);
  f = await bankCompany(pool, [[a, 'admin']], companies);
  other = await bankCompany(pool, [[a, 'admin']], companies);
  act = actionRoute(tokens);
  inactiveCc1 = (await pool.query(
    "INSERT INTO cost_centres(company_id, code, name, cc_type, is_active) VALUES($1,'OLD','Retired','cc1',false) RETURNING id", [f.c])).rows[0].id;
  activeCc2AsCc1 = (await pool.query(
    "INSERT INTO cost_centres(company_id, code, name, cc_type, is_active) VALUES($1,'PRJ','Project','cc2',true) RETURNING id", [f.c])).rows[0].id;
});
afterAll(async () => {
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM cost_centres WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a]); // ends the pool
});

const journals = async () => (await pool.query(
  'SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [f.c])).rows[0].n as number;
const status = async (id: string) => (await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [id])).rows[0].status as string;

/** The route's answer, and proof that nothing was written: no journal, the line still imported. */
async function refused(body: Record<string, unknown>, line: string) {
  const before = await journals();
  const answer = refusalOf(await act(a, f.c, body));
  expect({ journalsAdded: (await journals()) - before, status: await status(line) }).toEqual({ journalsAdded: 0, status: 'imported' });
  return answer;
}

describe('split_allocate: a split that does not foot is a 400', () => {
  it('R50 on a R120 line: 400 naming both totals, nothing written', async () => {
    const line = await plantLine(pool, f, null, -120);
    const answer = await refused({ action: 'split_allocate', bankTransactionId: line, lines: [{ contraAccountId: f.expA, amount: 50 }] }, line);
    expect(answer).toMatchObject({ status: 400, message: expect.stringMatching(/Split lines total R50\.00 does not equal transaction amount R120\.00/) });
  });
});

describe('allocate and split_allocate: an unusable cost centre or a foreign account is a 400', () => {
  it('allocate with an inactive CC1: 400, nothing written', async () => {
    const line = await plantLine(pool, f, null, -80);
    const answer = await refused({ action: 'allocate', bankTransactionId: line, contraAccountId: f.expA, cc1Id: inactiveCc1 }, line);
    expect(answer).toMatchObject({ status: 400, message: expect.stringMatching(/CC1 must name an active CC1 cost centre/) });
  });

  it('allocate with a CC2 centre in the CC1 slot, and with a cost centre that does not exist: 400', async () => {
    const line = await plantLine(pool, f, null, -80);
    expect((await refused({ action: 'allocate', bankTransactionId: line, contraAccountId: f.expA, cc1Id: activeCc2AsCc1 }, line)).status).toBe(400);
    expect((await refused({ action: 'allocate', bankTransactionId: line, contraAccountId: f.expA, cc1Id: crypto.randomUUID() }, line)).status).toBe(400);
  });

  it('split_allocate with an inactive CC1 on one line: 400, nothing written', async () => {
    const line = await plantLine(pool, f, null, -100);
    const answer = await refused({ action: 'split_allocate', bankTransactionId: line, lines: [
      { contraAccountId: f.expA, amount: 60 }, { contraAccountId: f.expB, amount: 40, cc1Id: inactiveCc1 }] }, line);
    expect(answer).toMatchObject({ status: 400, message: expect.stringMatching(/CC1 must name an active CC1 cost centre/) });
  });

  it('allocate to another company\'s account: 400, nothing written', async () => {
    const line = await plantLine(pool, f, null, -80);
    const answer = await refused({ action: 'allocate', bankTransactionId: line, contraAccountId: other.expA }, line);
    expect(answer).toMatchObject({ status: 400, message: expect.stringMatching(/GL account outside this company|not in this company/) });
  });

  it('allocate to an account that does not exist: 400', async () => {
    const line = await plantLine(pool, f, null, -80);
    expect((await refused({ action: 'allocate', bankTransactionId: line, contraAccountId: crypto.randomUUID() }, line)).status).toBe(400);
  });

  it('split_allocate with another company\'s account on one line: 400, nothing written', async () => {
    const line = await plantLine(pool, f, null, -100);
    const answer = await refused({ action: 'split_allocate', bankTransactionId: line, lines: [
      { contraAccountId: f.expA, amount: 60 }, { contraAccountId: other.expB, amount: 40 }] }, line);
    expect(answer).toMatchObject({ status: 400, message: expect.stringMatching(/GL account outside this company|not in this company/) });
  });

  it('control: a valid allocate and a valid split still post', async () => {
    const one = await plantLine(pool, f, null, -80);
    expect((await act(a, f.c, { action: 'allocate', bankTransactionId: one, contraAccountId: f.expA })).state.statusCode).toBe(200);
    const two = await plantLine(pool, f, null, -100);
    const res = await act(a, f.c, { action: 'split_allocate', bankTransactionId: two, lines: [
      { contraAccountId: f.expA, amount: 60 }, { contraAccountId: f.expB, amount: 40 }] });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await status(two)).toBe('allocated');
  });
});
