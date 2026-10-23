/**
 * AP-01 round 15 (adversarial REPRO 6/7): the settle must never fail on the content of Netcash's answer. A reference
 * longer than netcash_submissions.batch_reference (varchar(100)) made both settle attempts fail with 22001, the durable
 * record too (audit_log.entity_ref varchar(100)), and the late settler for ten minutes; after a restart the row was
 * freeable and the batch was sent twice. Now an over-long or malformed reference (or one with a NUL, which no text
 * column takes) settles the row on Netcash's OUTCOME with batch_reference NULL, the full reference kept in
 * netcash_response; the durable record keeps it in changes.metadata only. Judged by outcome. Disposable DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hold = vi.hoisted(() => ({ submitEftBatch: vi.fn(), getSubmissionStatus: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/netcashService', () => hold);

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import netcashResolve from '../../pages/api/accounting/netcash/resolve';
import netcashStatus from '../../pages/api/accounting/netcash/status';
import { dropLateSettlesForTests } from '@/modules/accounting/services/ap/netcashLateSettler';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantApprovedBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';
const LONG = `NC-${'X'.repeat(147)}`; // 150 characters
const ACCEPTED = { success: true, outcome: 'accepted', batchReference: 'NC-SHORT' };

beforeAll(async () => { admin = await createUser(pool, tokens); });
beforeEach(() => { hold.submitEftBatch.mockReset(); });
afterAll(async () => {
  dropLateSettlesForTests();
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
  await cleanupPr5(pool, companies, [admin]);
});

async function fresh() {
  const { company: c, bank } = await payCompany(pool, [[admin, 'admin']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  return { c, b: await plantApprovedBatch(pool, c, admin, bank) };
}
const submit = (c: string, batchId: string) => callRoute(netcashSubmit, tokens[admin]!, c, 'POST', { batchPaymentId: batchId }, '/api/accounting/netcash/submit');
const resolve = (c: string, id: string) => callRoute(netcashResolve, tokens[admin]!, c, 'POST',
  { submissionId: id, outcome: 'failed', note: 'portal shows nothing yet' }, '/api/accounting/netcash/resolve');
const row = async (id: string) => (await pool.query('SELECT status, batch_reference, netcash_response FROM netcash_submissions WHERE id = $1', [id])).rows[0] as
  { status: string; batch_reference: string | null; netcash_response: Record<string, unknown> | null };
const records = async (id: string) => (await pool.query(
  "SELECT entity_ref, changes FROM audit_log WHERE entity_type = 'netcash_unrecorded_answer' AND entity_id = $1", [id])).rows as
  Array<{ entity_ref: string | null; changes: { metadata?: { batchReference?: string } } }>;

/** A send parked in the stub sender; `answer(r)` lets Netcash reply. */
async function parked(c: string, batchId: string) {
  let reply!: (r: unknown) => void;
  let entered!: () => void;
  const inSender = new Promise<void>((r) => { entered = r; });
  hold.submitEftBatch.mockImplementationOnce(() => { entered(); return new Promise((r) => { reply = r; }); });
  const first = submit(c, batchId);
  await inSender;
  const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].id as string;
  return { first, id, answer: (r: unknown) => reply(r) };
}

describe('Netcash\'s answer cannot defeat its own settle (AP-01 round 15)', () => {
  it.each([
    ['REPRO 7: a 150-character reference', LONG, LONG],
    ['a reference with a NUL in it', 'NC-\u0000-NUL', 'NC--NUL'],
    ['a reference that is not text', 12345, null],
  ])('%s: settled on the outcome (submitted), batch_reference NULL, the reference kept in netcash_response; resend refused, 1 send', async (_n, ref, kept) => {
    const { c, b } = await fresh();
    const s = await parked(c, b.id);
    s.answer({ success: true, outcome: 'accepted', batchReference: ref });
    const first = await s.first;
    const after = await row(s.id);
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const again = await submit(c, b.id);
    expect({ first: first.state.statusCode, status: after.status, column: after.batch_reference,
      kept: kept === null ? true : JSON.stringify(after.netcash_response ?? {}).includes(JSON.stringify(kept)),
      resend: again.state.statusCode, sends: hold.submitEftBatch.mock.calls.length })
      .toEqual({ first: 200, status: 'submitted', column: null, kept: true, resend: 409, sends: 1 });
  });

  it('REPRO 6: the row held when Netcash answers with a 150-character reference: the durable record is written (reference in metadata), and after a restart freeing is refused naming it', async () => {
    const { c, b } = await fresh();
    const s = await parked(c, b.id);
    await pool.query("UPDATE netcash_submissions SET created_at = NOW() - INTERVAL '3 minutes' WHERE id = $1", [s.id]);
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM netcash_submissions WHERE id = $1 FOR UPDATE', [s.id]);
    s.answer({ success: true, outcome: 'accepted', batchReference: LONG });
    const first = await s.first;
    dropLateSettlesForTests(); // a restart
    await blocker.query('ROLLBACK');
    blocker.release();
    const kept = await records(s.id);
    const res = await resolve(c, s.id);
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const again = await submit(c, b.id);
    expect({ first: first.state.statusCode, records: kept.length, entityRef: kept[0] ? kept[0].entity_ref : 'none', metadataRef: kept[0]?.changes.metadata?.batchReference,
      resolve: res.state.statusCode, named: JSON.stringify(res.state.body).includes(LONG), status: (await row(s.id)).status,
      resend: again.state.statusCode, sends: hold.submitEftBatch.mock.calls.length })
      .toEqual({ first: 500, records: 1, entityRef: null, metadataRef: LONG, resolve: 409, named: true, status: 'pending', resend: 409, sends: 1 });
  }, 40_000);

  it('a status poll whose answer carries a NUL or a lone surrogate is still kept (as a hint), not a 500', async () => {
    const { c, b } = await fresh();
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    expect((await submit(c, b.id)).state.statusCode).toBe(200);
    const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].id as string;
    hold.getSubmissionStatus.mockResolvedValueOnce({ status: 'Processing\u0000', detail: 'queued \ud800 here', answered: true });
    const res = await callRoute(netcashStatus, tokens[admin]!, c, 'GET', undefined, '/api/accounting/netcash/status', { submissionId: id });
    const latest = (await row(id)).netcash_response?.latestPoll as { status?: string } | undefined;
    expect({ http: res.state.statusCode, status: (await row(id)).status, latest: latest?.status }).toEqual({ http: 200, status: 'processing', latest: 'Processing' });
  });

  // The adversary's round-15 content attacks (round 16: permanent). Each: the row settles, the batch stays closed.
  const big = 'Z'.repeat(2 * 1024 * 1024);
  it.each([
    ['NUL in a short reference', { success: true, outcome: 'accepted', batchReference: 'NC-\u0000-1' }, 'submitted'],
    ['lone high surrogate in reference', { success: true, outcome: 'accepted', batchReference: 'NC-\ud800' }, 'submitted'],
    ['lone low surrogate in reference', { success: true, outcome: 'accepted', batchReference: '\udc00NC' }, 'submitted'],
    ['backslash-u text in reference', { success: true, outcome: 'accepted', batchReference: 'NC-\\u0000-\\ud800' }, 'submitted'],
    ['2 MB reference', { success: true, outcome: 'accepted', batchReference: big }, 'submitted'],
    ['exactly 100 chars, multibyte', { success: true, outcome: 'accepted', batchReference: '\u00e9'.repeat(100) }, 'submitted'],
    ['51 emoji = 102 UTF-16 units', { success: true, outcome: 'accepted', batchReference: '\u{1F600}'.repeat(51) }, 'submitted'],
    ['50 emoji = 100 UTF-16 units, 50 chars', { success: true, outcome: 'accepted', batchReference: '\u{1F600}'.repeat(50) }, 'submitted'],
    ['NUL + surrogate in an unknown answer\'s error text', { success: false, outcome: 'unknown', error: 'boom\u0000\ud800' }, 'unknown'],
    ['a non-finite number as the reference', { success: true, outcome: 'accepted', batchReference: 1e400 }, 'submitted'],
    ['a NUL key with a surrogate value in the answer', { success: true, outcome: 'accepted', batchReference: 'NC-K', ['x\u0000y']: 'v\ud800' }, 'submitted'],
  ])('content: %s settles the row and keeps the batch closed (resend 409, 1 send)', async (_n, answered, expected) => {
    const { c, b } = await fresh();
    const s = await parked(c, b.id);
    s.answer(answered);
    const first = await s.first;
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const again = await submit(c, b.id);
    expect({ notError: first.state.statusCode !== 500, status: (await row(s.id)).status, resend: again.state.statusCode, sends: hold.submitEftBatch.mock.calls.length })
      .toEqual({ notError: true, status: expected, resend: 409, sends: 1 });
  }, 40_000);
});

