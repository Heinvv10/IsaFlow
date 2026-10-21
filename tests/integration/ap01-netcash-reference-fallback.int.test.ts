/**
 * AP-01 round 16.
 *   1. A row whose Netcash reference did not fit batch_reference (round 15: NULL there, whole in netcash_response) was
 *      never polled again ("No batch reference available"). status.ts now polls with the reference kept in
 *      netcash_response when it is usable for the API (text, at most 1024 characters, no control characters, no
 *      replacement character standing for a lost surrogate) - sent only to Netcash, never written into a column.
 *   2. resolve wrote the operator's note into netcash_response.resolved and audit_log unsanitised: a NUL failed the
 *      resolve (22P05). The note is made jsonb-safe first.
 * Judged by outcome: what the stub poller was asked, the row, the stored note. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hold = vi.hoisted(() => ({ submitEftBatch: vi.fn(), getSubmissionStatus: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/netcashService', () => hold);

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import netcashResolve from '../../pages/api/accounting/netcash/resolve';
import netcashStatus from '../../pages/api/accounting/netcash/status';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';
const LONG = `NC-${'R'.repeat(147)}`; // 150 characters: too long for batch_reference, fine for Netcash's API

beforeAll(async () => { admin = await createUser(pool, tokens); });
beforeEach(() => { hold.submitEftBatch.mockReset(); hold.getSubmissionStatus.mockReset(); });
afterAll(async () => {
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
  await cleanupPr5(pool, companies, [admin]);
});

async function submittedWith(batchReference: unknown) {
  const { company: c, bank } = await payCompany(pool, [[admin, 'admin']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  const b = await plantBatch(pool, c, admin, bank);
  hold.submitEftBatch.mockResolvedValueOnce({ success: true, outcome: 'accepted', batchReference });
  await callRoute(netcashSubmit, tokens[admin]!, c, 'POST', { batchPaymentId: b.id }, '/api/accounting/netcash/submit');
  const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].id as string;
  return { c, id };
}
const poll = (c: string, id: string) => callRoute(netcashStatus, tokens[admin]!, c, 'GET', undefined, '/api/accounting/netcash/status', { submissionId: id });
const row = async (id: string) => (await pool.query('SELECT status, batch_reference, netcash_response FROM netcash_submissions WHERE id = $1', [id])).rows[0] as
  { status: string; batch_reference: string | null; netcash_response: Record<string, unknown> };

describe('a reference too long for the column is still polled (AP-01 round 16)', () => {
  it('batch_reference NULL, the 150-character reference in netcash_response: the poll asks Netcash with it, the column stays NULL', async () => {
    const { c, id } = await submittedWith(LONG);
    hold.getSubmissionStatus.mockResolvedValueOnce({ status: 'Processing', detail: 'queued', answered: true });
    const res = await poll(c, id);
    const after = await row(id);
    expect({ http: res.state.statusCode, polled: (res.state.body as { data?: { polled?: boolean } }).data?.polled,
      askedWith: hold.getSubmissionStatus.mock.calls[0]?.[1], status: after.status, column: after.batch_reference })
      .toEqual({ http: 200, polled: true, askedWith: LONG, status: 'processing', column: null });
  });

  it.each([
    ['too long even for the API (2000 characters)', `NC-${'Q'.repeat(1997)}`],
    ['a control character in it', `NC-${'S'.repeat(100)}\u0007`],
    ['not text', 12345],
  ])('a reference not usable for the API (%s): no call, the stored status is shown', async (_n, ref) => {
    const { c, id } = await submittedWith(ref);
    const res = await poll(c, id);
    expect({ http: res.state.statusCode, polled: (res.state.body as { data?: { polled?: boolean } }).data?.polled,
      calls: hold.getSubmissionStatus.mock.calls.length, detail: /no batch reference/i.test(JSON.stringify(res.state.body)) })
      .toEqual({ http: 200, polled: false, calls: 0, detail: true });
  });
});

describe('the operator\'s note is made jsonb-safe (AP-01 round 16)', () => {
  it('a note with a NUL and a lone surrogate: 200, stored cleaned on the row and in the audit log', async () => {
    const { c, id } = await submittedWith('NC-NOTE');
    const res = await callRoute(netcashResolve, tokens[admin]!, c, 'POST',
      { submissionId: id, outcome: 'failed', note: 'Portal\u0000 says \ud800rejected' }, '/api/accounting/netcash/resolve');
    const resolved = (await row(id)).netcash_response.resolved as { note?: string } | undefined;
    const audit = (await pool.query("SELECT changes FROM audit_log WHERE company_id = $1 AND entity_type = 'netcash_submission' AND entity_id = $2", [c, id])).rows[0]?.changes;
    expect({ http: res.state.statusCode, status: (await row(id)).status, note: resolved?.note, audited: JSON.stringify(audit ?? {}).includes('Portal says �rejected') })
      .toEqual({ http: 200, status: 'failed', note: 'Portal says �rejected', audited: true });
  });
});
