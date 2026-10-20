/**
 * AP-01: the status poller maps free-text Netcash status strings to our enum.
 * Anything containing "error"/"fail"/"reject" became 'failed' - which leaves the
 * partial unique index and frees a batch Netcash had accepted for a second
 * send. A poll must never move a live submission to 'failed': the row stays
 * live (the latest poll is kept in netcash_response for the operator) and the
 * batch stays closed. Judged by outcome: the row's status and whether a resubmit
 * reaches Netcash's sender. Netcash is never called. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const netcash = vi.hoisted(() => ({ submitEftBatch: vi.fn(), getSubmissionStatus: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/netcashService', () => netcash);

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import netcashStatus from '../../pages/api/accounting/netcash/status';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';

beforeAll(async () => { user = await createUser(pool, tokens); });
beforeEach(() => {
  netcash.submitEftBatch.mockReset();
  netcash.getSubmissionStatus.mockReset();
  netcash.submitEftBatch.mockResolvedValue({ success: true, outcome: 'accepted', batchReference: 'NC-POLL' });
});
afterAll(() => cleanupPr5(pool, companies, [user]));

async function submittedBatch() {
  const { company: c, bank } = await payCompany(pool, [[user, 'admin']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  const b = await plantBatch(pool, c, user, bank);
  const res = await callRoute(netcashSubmit, tokens[user]!, c, 'POST', { batchPaymentId: b.id }, '/api/accounting/netcash/submit');
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].id as string;
  return { c, b, id };
}
const poll = (c: string, id: string, answer: string) => {
  netcash.getSubmissionStatus.mockResolvedValue({ status: answer, detail: 'from netcash' });
  return callRoute(netcashStatus, tokens[user]!, c, 'GET', undefined, '/api/accounting/netcash/status', { submissionId: id });
};
const stored = async (id: string) => (await pool.query('SELECT status, netcash_response FROM netcash_submissions WHERE id = $1', [id])).rows[0] as
  { status: string; netcash_response: { latestPoll?: { status: string } } };

describe('netcash/status never frees a live batch (AP-01)', () => {
  it.each(['error', 'Failed', 'rejected by bank', 'REJECT'])('a poll answering "%s" leaves the submission live and the batch closed', async (word) => {
    const { c, b, id } = await submittedBatch();
    const res = await poll(c, id, word);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const row = await stored(id);
    expect(row.status).not.toBe('failed');
    expect(row.netcash_response.latestPoll?.status).toBe(word); // kept for the operator
    const again = await callRoute(netcashSubmit, tokens[user]!, c, 'POST', { batchPaymentId: b.id }, '/api/accounting/netcash/submit');
    expect(again.state.statusCode).toBe(409);
    expect(netcash.submitEftBatch).toHaveBeenCalledTimes(1);
  });

  it('the answer tells the caller Netcash reports a failure that needs an operator, not that the batch is free', async () => {
    const { c, id } = await submittedBatch();
    const res = await poll(c, id, 'failed');
    const body = JSON.stringify(res.state.body);
    expect(body).toMatch(/check Netcash|operator/i);
    expect(body).not.toMatch(/"status":"failed"/);
  });

  it('a poll answering "completed" or "processing" still moves the status', async () => {
    const { c, id } = await submittedBatch();
    await poll(c, id, 'processing');
    expect((await stored(id)).status).toBe('processing');
    await poll(c, id, 'completed');
    expect((await stored(id)).status).toBe('completed');
  });
});
