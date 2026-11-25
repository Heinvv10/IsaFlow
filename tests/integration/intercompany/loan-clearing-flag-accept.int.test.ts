/**
 * The dark flag `intercompany_loan_clearing` (migration 1028), the RECEIVER's side: with the flag off for the receiver (A), `acceptAllocation`
 * refuses `not_enabled` (403) as its FIRST step, the accept route answers 403 with a plain sentence (before it even reads the body), no journal
 * or receipt is posted and the message is left exactly as it was. The list and the detail say `loanClearingEnabled: false` (and the detail
 * carries no Accept preview), while Reject, Dismiss and Restore still work. Only the RECEIVER's flag decides an accept: A on and B off, A
 * accepts B's message.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { acceptAllocation } from '../../../src/modules/accounting/services/intercompany/allocationClearService';
import { co, U, wipeConnections } from './intercompany.helpers';
import { asService, dataOf, errorOf, mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { allocationsApi } from './allocation-live.helpers';
import { accept, bodyFor, clearConnect, clearSetup, ledger, outcomeOf, sentClearable } from './allocation-clear.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import type { AllocationDetail, AllocationPage } from '../../../src/modules/accounting/services/intercompany/allocationInboxTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => clearSetup(pool), 60000);
afterAll(async () => {
  await setLoanClearing(pool, [co.A, co.B, co.C], true);
  await clearPayments(pool);
  await mirrorCleanup(pool);
}, 60000);
beforeEach(async () => {
  await setLoanClearing(pool, [co.A, co.B, co.C], true);
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

type Sent = Awaited<ReturnType<typeof sentClearable>>;
const MESSAGE_COLUMNS = 'status, error, reason, target_doc_type, target_doc_id, handled_by, handled_at, payload';
const messageRow = async (id: string) => (await pool.query(`SELECT ${MESSAGE_COLUMNS} FROM intercompany_messages WHERE id = $1`, [id])).rows[0];
const books = async () => [await ledger.journals(pool), await ledger.receipts(pool), await ledger.journals(pool, co.B)];

/** Runs `call` and proves nothing moved: the message row byte-for-byte as before, no journal or receipt in either company. */
async function untouched<T>(sent: Sent, call: () => Promise<T>): Promise<T> {
  const [before, ledgerBefore] = [await messageRow(sent.message), await books()];
  const out = await call();
  expect(await messageRow(sent.message)).toEqual(before);
  expect(await books()).toEqual(ledgerBefore);
  return out;
}

describe('flag OFF for the receiver: nothing can be accepted', () => {
  it('acceptAllocation refuses not_enabled (403) before anything, nothing posted, the message unchanged', async () => {
    await setLoanClearing(pool, [co.A], false);
    const sent = await sentClearable(pool, conn);
    const err = await untouched(sent, () => asService(pool, U.a, co.A,
      () => acceptAllocation({ companyId: co.A, messageId: sent.message, userId: U.a, input: bodyFor(sent) })).then(() => null, (e: unknown) => e));
    expect(err).toMatchObject({ status: 403, code: 'not_enabled' });
    expect((await messageRow(sent.message)).status).toBe('pending');
  });

  it('the accept route answers 403 with a plain sentence, for a good body and for a body it would otherwise refuse (400)', async () => {
    await setLoanClearing(pool, [co.A], false);
    const sent = await sentClearable(pool, conn);
    const res = await untouched(sent, () => accept(sent.message, bodyFor(sent)));
    expect(res.state.statusCode).toBe(403);
    expect(errorOf(res)).toBe('Clearing intercompany payments against the loan account is not enabled for this company.');
    const bad = await untouched(sent, () => accept(sent.message, { nonsense: true }));
    expect(bad.state.statusCode).toBe(403);
  });

  it('no override at all (the default) is off too', async () => {
    await setLoanClearing(pool, [co.A], null);
    const sent = await sentClearable(pool, conn);
    expect((await untouched(sent, () => accept(sent.message, bodyFor(sent)))).state.statusCode).toBe(403);
  });

  it('the list and the detail say loanClearingEnabled false, the detail carries no Accept preview; Reject, Dismiss and Restore still work', async () => {
    await setLoanClearing(pool, [co.A], false);
    const one = await sentClearable(pool, conn);
    const two = await sentClearable(pool, conn);
    const page = dataOf<AllocationPage>(await allocationsApi.list(U.a, co.A, { filter: 'open' }));
    expect(page.loanClearingEnabled).toBe(false);
    expect(page.items.map((i) => i.id).sort()).toEqual([one.message, two.message].sort());
    const detail = dataOf<AllocationDetail>(await allocationsApi.get(U.a, co.A, one.message));
    expect(detail).toMatchObject({ loanClearingEnabled: false, preview: null });
    expect((await allocationsApi.dismiss(U.a, co.A, one.message)).state.statusCode).toBe(200);
    expect((await ledger.message(pool, one.message)).status).toBe('dismissed');
    expect((await allocationsApi.restore(U.a, co.A, one.message)).state.statusCode).toBe(200);
    expect((await ledger.message(pool, one.message)).status).toBe('pending');
    expect((await allocationsApi.reject(U.a, co.A, two.message, { reason: 'Not ours' })).state.statusCode).toBe(200);
    expect((await ledger.message(pool, two.message)).status).toBe('rejected');
  });
});

describe('flag ON: per company, the receiver\'s flag decides', () => {
  it('A on, B off: the list and detail say true with a preview, and A accepts B\'s message (one journal)', async () => {
    // (1031, L-1: the sender asks the payer's flag in SQL too, so the message is sent while B's is on; then B's goes off)
    const sent = await sentClearable(pool, conn);
    await setLoanClearing(pool, [co.B], false);
    expect(dataOf<AllocationPage>(await allocationsApi.list(U.a, co.A, { filter: 'open' })).loanClearingEnabled).toBe(true);
    const detail = dataOf<AllocationDetail>(await allocationsApi.get(U.a, co.A, sent.message));
    expect(detail.loanClearingEnabled).toBe(true);
    expect(detail.preview).not.toBeNull();
    const journals = await ledger.journals(pool);
    const res = await accept(sent.message, bodyFor(sent));
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(outcomeOf(res)).toMatchObject({ accepted: true, messageId: sent.message });
    expect(await ledger.journals(pool)).toBe(journals + 1);
    expect((await ledger.message(pool, sent.message)).status).toBe('accepted');
  });

  it('turned on after a refusal, the same message is accepted (the refusal stored nothing)', async () => {
    await setLoanClearing(pool, [co.A], false);
    const sent = await sentClearable(pool, conn);
    expect((await accept(sent.message, bodyFor(sent))).state.statusCode).toBe(403);
    await setLoanClearing(pool, [co.A], true);
    const res = await accept(sent.message, bodyFor(sent));
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(outcomeOf(res).accepted).toBe(true);
  });
});
