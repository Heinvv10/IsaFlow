/**
 * AP-01: a batch Netcash may hold must not be cancelled or reversed. Both put
 * the batch's bills back in the payable pool, where a new batch pays them a
 * second time. cancelBatch and the batch reversal refuse while the batch has a
 * submission that is not 'failed' (submitted, completed, processing, pending,
 * unknown); a definitely rejected one does not block them.
 *
 * Judged by OUTCOME: the batch's final status, its members', the journals and
 * the bills' amount_paid. The race parks the submit inside Netcash's (mocked)
 * sender, with the batch row share-locked and the claim committed, and starts
 * the real cancel: it waits on the batch row, then must find the claim.
 * Netcash is never called. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const sender = vi.hoisted(() => ({
  submitEftBatch: vi.fn(),
  park: null as null | { entered: () => void; hold: Promise<void> },
}));
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch: sender.submitEftBatch }));

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { batchState, cleanupPr5, payCompany, payRoutes, plantBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
const r = payRoutes(tokens);

const ACCEPTED = { success: true, outcome: 'accepted', batchReference: 'NC-CANCEL' };
const UNKNOWN = { success: false, outcome: 'unknown', error: 'The operation was aborted' };
const REJECTED = { success: false, outcome: 'rejected', error: 'Invalid account number' };

beforeAll(async () => { user = await createUser(pool, tokens); });
beforeEach(() => {
  sender.submitEftBatch.mockReset();
  sender.park = null;
  sender.submitEftBatch.mockResolvedValue(ACCEPTED);
});
afterAll(() => cleanupPr5(pool, companies, [user]));

async function approvedBatch() {
  const { company: c, bank } = await payCompany(pool, [[user, 'admin']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  const b = await plantBatch(pool, c, user, bank);
  expect((await r.batch(user, c, 'approve', b.id)).state.statusCode).toBe(200);
  return { c, b };
}
const submit = (c: string, id: string) => callRoute(netcashSubmit, tokens[user]!, c, 'POST', { batchPaymentId: id }, '/api/accounting/netcash/submit');
const cancel = (c: string, id: string) => r.batch(user, c, 'cancel', id);

describe('cancelBatch against a Netcash submission (AP-01)', () => {
  it.each([['accepted', ACCEPTED], ['unknown', UNKNOWN]])('a batch with an %s submission cannot be cancelled', async (_n, answer) => {
    const { c, b } = await approvedBatch();
    sender.submitEftBatch.mockResolvedValue(answer);
    await submit(c, b.id);
    const res = await cancel(c, b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.state.body)).toMatch(/Netcash/);
    expect(await batchState(pool, b.id)).toMatchObject({ status: 'approved', members: ['approved', 'approved'] });
  });

  it('a batch Netcash definitely rejected can be cancelled', async () => {
    const { c, b } = await approvedBatch();
    sender.submitEftBatch.mockResolvedValue(REJECTED);
    expect((await submit(c, b.id)).state.statusCode).toBe(400);
    expect((await cancel(c, b.id)).state.statusCode).toBe(200);
    expect(await batchState(pool, b.id)).toMatchObject({ status: 'cancelled' });
  });

  it('a cancel that starts while the submit is in flight waits, and is then refused', async () => {
    const { c, b } = await approvedBatch();
    let release!: () => void;
    let entered!: () => void;
    const inSender = new Promise<void>((res) => { entered = res; });
    sender.park = { entered, hold: new Promise<void>((res) => { release = res; }) };
    sender.submitEftBatch.mockImplementation(async () => {
      const park = sender.park;
      if (park) { sender.park = null; park.entered(); await park.hold; }
      return ACCEPTED;
    });
    const submitP = submit(c, b.id);
    await inSender;
    const cancelP = cancel(c, b.id);
    const state = await Promise.race([cancelP.then(() => 'finished' as const), waitsOnBatchLock()]);
    release();
    const [sent, cancelled] = await Promise.all([submitP, cancelP]);
    expect(state).toBe('waiting');
    expect(sent.state.statusCode, JSON.stringify(sent.state.body)).toBe(200);
    expect(cancelled.state.statusCode).toBeGreaterThanOrEqual(400);
    expect(await batchState(pool, b.id)).toMatchObject({ status: 'approved', members: ['approved', 'approved'] });
  });
});

describe('batch reversal against a Netcash submission (AP-01)', () => {
  it('a processed batch that was sent to Netcash cannot be reversed: its bills stay paid', async () => {
    const { c, b } = await approvedBatch();
    expect((await r.batch(user, c, 'process', b.id)).state.statusCode).toBe(200);
    expect((await submit(c, b.id)).state.statusCode).toBe(200);
    const before = await batchState(pool, b.id);
    const res = await r.batch(user, c, 'reverse', b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.state.body)).toMatch(/Netcash/);
    const after = await batchState(pool, b.id);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ status: 'processed', journals: 1 });
    expect(after.paid).toBeGreaterThan(0);
  });

  it('a processed batch Netcash rejected can still be reversed', async () => {
    const { c, b } = await approvedBatch();
    expect((await r.batch(user, c, 'process', b.id)).state.statusCode).toBe(200);
    sender.submitEftBatch.mockResolvedValue(REJECTED);
    expect((await submit(c, b.id)).state.statusCode).toBe(400);
    const res = await r.batch(user, c, 'reverse', b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await batchState(pool, b.id)).toMatchObject({ status: 'reversed', paid: 0 });
  });
});

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
