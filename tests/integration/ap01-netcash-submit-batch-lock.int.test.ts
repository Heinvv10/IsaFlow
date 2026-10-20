/**
 * AP-01: netcash/submit read the batch row unlocked, then judged its status
 * (assertBatchMayBeSent, under payment_batch enforcement). A cancelBatch that
 * committed between the two let the send happen for a batch that was cancelled.
 * The batch row is now read FOR SHARE first, so cancelBatch (an UPDATE of the
 * row) waits for the submit's transaction.
 *
 * Judged by OUTCOME: the batch's committed status at the instant Netcash's
 * sender is called. Deterministic: the submit is parked just after the gate has
 * judged the batch approved, the real cancel (batch-payments-action) is started,
 * and the submit is released only once the cancel has finished or waits on a lock.
 * Netcash itself is never called. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const mocks = vi.hoisted(() => ({
  submitEftBatch: vi.fn(),
  park: null as null | { entered: () => void; hold: Promise<void> },
}));
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch: mocks.submitEftBatch }));
vi.mock('@/modules/accounting/services/ap/batchBankFileGate', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/ap/batchBankFileGate')>();
  return {
    ...actual,
    assertBatchMayBeSent: async (...a: Parameters<typeof actual.assertBatchMayBeSent>) => {
      await actual.assertBatchMayBeSent(...a); // judged: approved and cleared
      const park = mocks.park;
      if (park) { mocks.park = null; park.entered(); await park.hold; }
    },
  };
});

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { cleanupPr5, enforcePay, payCompany, payRoutes, plantBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = payRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
beforeEach(() => {
  mocks.submitEftBatch.mockReset();
  mocks.park = null;
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

/** An approved, enforcement-cleared batch of a company that may use Netcash. */
async function clearedBatch() {
  const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  for (const type of ['supplier_payment', 'payment_batch'] as const) await plantRule(pool, c, 'owner', { documentType: type });
  await enforcePay(pool, c, 'payment_batch', u.b);
  const b = await plantBatch(pool, c, u.a, bank);
  await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
  expect((await r.batch(u.a, c, 'approve', b.id)).state.statusCode).toBe(200);
  return { c, b };
}

async function waitsOnBatchLock(): Promise<'waiting'> {
  for (let i = 0; i < 500; i += 1) {
    const res = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%supplier_payment_batches%'`);
    if (res.rowCount) return 'waiting';
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('nothing finished and nothing waited on a supplier_payment_batches lock');
}

describe('netcash/submit against a cancel of the same batch (AP-01)', () => {
  it('Netcash is never sent a batch that was already cancelled', async () => {
    const { c, b } = await clearedBatch();
    const statusWhenSent: string[] = [];
    mocks.submitEftBatch.mockImplementation(async () => {
      statusWhenSent.push((await pool.query('SELECT status FROM supplier_payment_batches WHERE id = $1', [b.id])).rows[0].status);
      return { success: true, outcome: 'accepted', batchReference: 'NC-LOCK' };
    });

    let release!: () => void;
    let entered!: () => void;
    const inGate = new Promise<void>((res) => { entered = res; });
    mocks.park = { entered, hold: new Promise<void>((res) => { release = res; }) };
    const submitP = callRoute(netcashSubmit, tokens[u.a]!, c, 'POST', { batchPaymentId: b.id }, '/api/accounting/netcash/submit');
    await inGate; // the batch has been judged approved; nothing sent yet
    const cancelP = r.batch(u.a, c, 'cancel', b.id);
    const state = await Promise.race([cancelP.then(() => 'finished' as const), waitsOnBatchLock()]);
    release();
    const [submit, cancel] = await Promise.all([submitP, cancelP]);

    // Whichever order the two take, the sender never saw a cancelled batch.
    expect(statusWhenSent.filter((s) => s === 'cancelled')).toEqual([]);
    expect(state).toBe('waiting'); // the cancel queued behind the submit's lock on the batch row
    expect(submit.state.statusCode, JSON.stringify(submit.state.body)).toBe(200);
    expect(statusWhenSent).toEqual(['approved']);
    expect(cancel.state.statusCode, JSON.stringify(cancel.state.body)).toBe(200);
  });

  it('a batch cancelled before the submit reads it is refused without a send', async () => {
    const { c, b } = await clearedBatch();
    expect((await r.batch(u.a, c, 'cancel', b.id)).state.statusCode).toBe(200);
    const res = await callRoute(netcashSubmit, tokens[u.a]!, c, 'POST', { batchPaymentId: b.id }, '/api/accounting/netcash/submit');
    expect(res.state.statusCode).toBe(409);
    expect(mocks.submitEftBatch).not.toHaveBeenCalled();
    expect((await pool.query('SELECT count(*)::INT AS n FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].n).toBe(0);
  });
});
