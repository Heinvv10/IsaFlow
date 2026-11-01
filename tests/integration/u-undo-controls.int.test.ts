/**
 * Master plan U (decision 7): Undo adds no way around forensic controls. Through the route, as the toast calls it,
 * naming the journal it offered: the allocator's own Undo under enforcement is refused 403 ALLOCATOR_MAY_NOT_REVERSE
 * and posts nothing, and the same call from another member goes through.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import {
  actionRoute, bankCompany, cleanupBankControlsA, enforce, plantBatch, plantLine, refusalOf,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
let act: ReturnType<typeof actionRoute>;

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); act = actionRoute(tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, [a, b]));

async function allocatedByA() {
  const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  const line = await plantLine(pool, f, await plantBatch(pool, f, b));
  const res = await act(a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account', contraAccountId: f.expA });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  await enforce(pool, f.c, a, ['manual_journal']);
  const je = (res.state.body as { data: { journalEntryId: string } }).data.journalEntryId;
  const contras = async () => (await pool.query(
    'SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1 AND reversal_of_id = $2', [f.c, je])).rows[0].n as number;
  return { c: f.c, line, je, contras };
}

describe('U: an Undo under ALLOCATOR_MAY_NOT_REVERSE', () => {
  it('the allocator is refused, nothing is posted and the line stays allocated', async () => {
    const f = await allocatedByA();
    const res = await act(a, f.c, { action: 'reverse', bankTransactionId: f.line, expectedJournalEntryId: f.je });
    expect(refusalOf(res)).toMatchObject({ status: 403, reason: 'ALLOCATOR_MAY_NOT_REVERSE' });
    expect(await f.contras()).toBe(0);
    expect((await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [f.line])).rows[0].status).toBe('allocated');
  });

  it('another member\'s call goes through', async () => {
    const f = await allocatedByA();
    const res = await act(b, f.c, { action: 'reverse', bankTransactionId: f.line, expectedJournalEntryId: f.je });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await f.contras()).toBe(1);
  });
});
