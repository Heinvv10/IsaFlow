/**
 * AP-10 / review round 1 on AP-02 — which batches and which members a BANK FILE
 * (eft-generate) or a Netcash submission may carry, with approval enforcement
 * OFF (the gate used to return before looking at the status at all):
 *   - a cancelled or reversed batch is never sent (409), by either route;
 *   - a draft batch still is (companies without enforcement export drafts today);
 *   - a cancelled member payment is not a payee: it is neither written to the
 *     file nor transmitted, nor counted in the totals.
 * Judged by the file's records, the Netcash sender's calls and the submissions
 * table, not by an error code. Netcash is never called: its client is a spy.
 * Disposable DB only (assertDisposable).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const submitEftBatch = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch }));

import eftGenerate from '../../pages/api/accounting/eft-generate';
import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { cleanupPr5, payCompany, plantBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';

beforeAll(async () => {
  user = await createUser(pool, tokens);
});
beforeEach(() => {
  submitEftBatch.mockReset();
  submitEftBatch.mockResolvedValue({ success: true, batchReference: 'AP10-SPY', mock: true });
});
afterAll(() => cleanupPr5(pool, companies, [user])); // ends the pool

async function fixture() {
  const { company: c, bank } = await payCompany(pool, [[user, 'admin']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  return { c, batch: await plantBatch(pool, c, user, bank) };
}
const eft = (c: string, batchId: string) =>
  callRoute(eftGenerate, tokens[user]!, c, 'POST', { batchId, bank: 'fnb' }, '/api/accounting/eft-generate');
const netcash = (c: string, batchPaymentId: string) =>
  callRoute(netcashSubmit, tokens[user]!, c, 'POST', { batchPaymentId }, '/api/accounting/netcash/submit');
const submissions = async (c: string) =>
  (await pool.query('SELECT count(*)::INT AS n FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].n as number;
const records = (content: string) => content.split('\n').filter((l) => l.startsWith('STD'));

describe('batch status, enforcement off', () => {
  it.each(['cancelled', 'reversed'])('a %s batch gets no EFT file and no Netcash submission', async (status) => {
    const { c, batch } = await fixture();
    await pool.query('UPDATE supplier_payment_batches SET status = $2 WHERE id = $1', [batch.id, status]);
    const file = await eft(c, batch.id);
    expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(409);
    expect(JSON.stringify(file.state.body)).not.toContain('"content"');
    const sent = await netcash(c, batch.id);
    expect(sent.state.statusCode, JSON.stringify(sent.state.body)).toBe(409);
    expect(submitEftBatch).not.toHaveBeenCalled();
    expect(await submissions(c)).toBe(0);
  });

  it.each(['draft', 'approved', 'processed'])('a %s batch is still sent', async (status) => {
    const { c, batch } = await fixture();
    await pool.query('UPDATE supplier_payment_batches SET status = $2 WHERE id = $1', [batch.id, status]);
    const file = await eft(c, batch.id);
    expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(200);
    expect(records(dataOf<{ content: string }>(file).content)).toHaveLength(2);
    expect((await netcash(c, batch.id)).state.statusCode).toBe(200);
    expect(submitEftBatch).toHaveBeenCalledTimes(1);
  });
});

describe('cancelled member payments', () => {
  it('are not in the EFT file, its count or its total', async () => {
    const { c, batch } = await fixture();
    await pool.query('UPDATE supplier_payments SET status = $2 WHERE id = $1', [batch.members[0]!.id, 'cancelled']);
    const res = await eft(c, batch.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const data = dataOf<{ content: string; paymentCount: number; totalAmount: number }>(res);
    expect(records(data.content)).toHaveLength(1);
    expect(data.paymentCount).toBe(1);
    expect(data.totalAmount).toBe(2300);
    expect(data.content).not.toContain('000000115000');
  });

  it('are not transmitted to Netcash, nor recorded in its submission', async () => {
    const { c, batch } = await fixture();
    await pool.query('UPDATE supplier_payments SET status = $2 WHERE id = $1', [batch.members[0]!.id, 'cancelled']);
    expect((await netcash(c, batch.id)).state.statusCode).toBe(200);
    const sent = submitEftBatch.mock.calls[0]![2] as { amount: number }[];
    expect(sent.map((p) => p.amount)).toEqual([230000]);
    const row = (await pool.query('SELECT total_amount_cents::INT AS t, record_count FROM netcash_submissions WHERE company_id = $1', [c])).rows[0];
    expect(row).toEqual({ t: 230000, record_count: 1 });
  });

  it('a batch whose every member is cancelled has nothing to send', async () => {
    const { c, batch } = await fixture();
    await pool.query("UPDATE supplier_payments SET status = 'cancelled' WHERE batch_id = $1", [batch.id]);
    expect((await eft(c, batch.id)).state.statusCode).toBe(400);
    expect((await netcash(c, batch.id)).state.statusCode).toBe(400);
    expect(submitEftBatch).not.toHaveBeenCalled();
  });
});
