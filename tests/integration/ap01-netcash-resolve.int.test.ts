/**
 * AP-01: no app route released a 'pending' or 'unknown' Netcash claim, so
 * production SQL was the only way out. POST /api/accounting/netcash/resolve
 * lets an owner or admin record what they found at Netcash: 'failed' (it never
 * got the batch - the batch may be sent again) or 'submitted' (it has the batch
 * - the batch stays closed). Company-scoped, role-gated, compare-and-set on the
 * status read, and audit-logged. A submitted/processing row may be freed as
 * 'failed' too, on the operator's attestation alone (never on a poll): that is
 * ap01-netcash-poll-not-evidence.int.test.ts.
 *
 * The CAS race is made deterministic: the resolve is parked just after it read
 * the row, the row is settled underneath it, and it is released. Netcash is
 * never called. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hold = vi.hoisted(() => ({
  park: null as null | { entered: () => void; release: Promise<void> },
  submitEftBatch: vi.fn(),
  getSubmissionStatus: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({
  submitEftBatch: hold.submitEftBatch, getSubmissionStatus: hold.getSubmissionStatus,
}));
vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    if (hold.park && /netcash_resolve_read/.test(text)) {
      const { entered, release } = hold.park;
      hold.park = null;
      return original.sql(strings, ...values).then(async (rows) => { entered(); await release; return rows; });
    }
    return original.sql(strings, ...values);
  };
  Object.assign(sql, { transaction: original.sql.transaction, unsafe: original.sql.unsafe, query: original.sql.query });
  return { ...original, sql };
});

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import netcashResolve from '../../pages/api/accounting/netcash/resolve';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { admin: '', manager: '', other: '' };

const UNKNOWN = { success: false, outcome: 'unknown', error: 'The operation was aborted' };
const ACCEPTED = { success: true, outcome: 'accepted', batchReference: 'NC-RESOLVE' };

beforeAll(async () => { for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens); });
beforeEach(() => { hold.submitEftBatch.mockReset(); hold.park = null; });
afterAll(async () => {
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
  await cleanupPr5(pool, companies, Object.values(u));
});

async function freshBatch() {
  const { company: c, bank } = await payCompany(pool, [[u.admin, 'admin'], [u.manager, 'manager']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  return { c, b: await plantBatch(pool, c, u.admin, bank) };
}

/** A company with a batch whose submission is 'unknown' (Netcash timed out). */
async function unknownBatch() {
  const { c, b } = await freshBatch();
  hold.submitEftBatch.mockResolvedValueOnce(UNKNOWN);
  await submit(c, b.id);
  const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].id as string;
  return { c, b, id };
}
const submit = (c: string, batchId: string) => callRoute(netcashSubmit, tokens[u.admin]!, c, 'POST',
  { batchPaymentId: batchId }, '/api/accounting/netcash/submit');
const resolve = (user: string, c: string, body: Record<string, unknown>) => callRoute(netcashResolve, tokens[user]!, c, 'POST', body,
  '/api/accounting/netcash/resolve');
const row = async (id: string) => (await pool.query('SELECT status, netcash_response FROM netcash_submissions WHERE id = $1', [id])).rows[0] as
  { status: string; netcash_response: { resolved?: { outcome: string; note: string; by: string; previousStatus: string } } };
const NOTE = 'Checked the Netcash portal: batch is not there';

describe('netcash/resolve (AP-01)', () => {
  it('an owner/admin resolves an unknown claim to failed: audit-logged, and the batch may be sent again', async () => {
    const { c, b, id } = await unknownBatch();
    expect((await submit(c, b.id)).state.statusCode).toBe(409);
    const res = await resolve(u.admin, c, { submissionId: id, outcome: 'failed', note: NOTE });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const after = await row(id);
    expect(after.status).toBe('failed');
    expect(after.netcash_response.resolved).toMatchObject({ outcome: 'failed', note: NOTE, previousStatus: 'unknown' });
    const audit = (await pool.query("SELECT user_id, action, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'netcash_submission' AND entity_id = $2", [c, id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(u.admin);
    expect(JSON.stringify(audit[0].changes)).toContain(NOTE);
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    expect((await submit(c, b.id)).state.statusCode).toBe(200);
    expect(hold.submitEftBatch).toHaveBeenCalledTimes(2);
  });

  it('resolving to submitted keeps the batch closed', async () => {
    const { c, b, id } = await unknownBatch();
    expect((await resolve(u.admin, c, { submissionId: id, outcome: 'submitted', note: 'It is in the portal' })).state.statusCode).toBe(200);
    expect((await row(id)).status).toBe('submitted');
    expect((await submit(c, b.id)).state.statusCode).toBe(409);
    expect(hold.submitEftBatch).toHaveBeenCalledTimes(1);
  });

  it('a manager (below owner/admin) is refused 403 and the claim is untouched', async () => {
    const { c, id } = await unknownBatch();
    const res = await resolve(u.manager, c, { submissionId: id, outcome: 'failed', note: NOTE });
    expect(res.state.statusCode).toBe(403);
    expect((await row(id)).status).toBe('unknown');
  });

  it('a user in two companies cannot resolve company A\'s claim from company B: 404 (RLS is membership-wide, so the predicate must hold)', async () => {
    const { c, id } = await unknownBatch();
    await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'admin')", [c, u.other]);
    const { company: other } = await payCompany(pool, [[u.other, 'admin']], companies);
    const res = await resolve(u.other, other, { submissionId: id, outcome: 'failed', note: NOTE });
    expect(res.state.statusCode).toBe(404);
    expect((await row(id)).status).toBe('unknown');
  });

  it.each([['failed', 'failed'], ['completed', 'failed'], ['completed', 'submitted'], ['submitted', 'submitted']])(
    'a %s submission resolved as %s is refused 409 (submitted/processing -> failed is in ap01-netcash-poll-not-evidence)', async (status, outcome) => {
    const { c, id } = await unknownBatch();
    await pool.query('UPDATE netcash_submissions SET status = $2 WHERE id = $1', [id, status]);
    const res = await resolve(u.admin, c, { submissionId: id, outcome, note: NOTE });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect((await row(id)).status).toBe(status);
  });

  it.each([
    ['no note', { outcome: 'failed' }],
    ['a blank note', { outcome: 'failed', note: '   ' }],
    ['an unknown outcome', { outcome: 'completed', note: NOTE }],
    ['a non-uuid id', { submissionId: 'nope', outcome: 'failed', note: NOTE }],
  ])('%s is refused 400 and changes nothing', async (_n, body) => {
    const { c, id } = await unknownBatch();
    const res = await resolve(u.admin, c, { submissionId: id, ...body });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect((await row(id)).status).toBe('unknown');
  });

  it('compare-and-set: a claim settled underneath the resolve is not overwritten', async () => {
    const { c, b, id } = await unknownBatch();
    let release!: () => void;
    let entered!: () => void;
    const inRead = new Promise<void>((r) => { entered = r; });
    hold.park = { entered, release: new Promise<void>((r) => { release = r; }) };
    const resolveP = resolve(u.admin, c, { submissionId: id, outcome: 'failed', note: NOTE });
    await inRead; // the resolve has read 'unknown'
    await pool.query("UPDATE netcash_submissions SET status = 'submitted' WHERE id = $1", [id]); // someone established it was sent
    release();
    const res = await resolveP;
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect((await row(id)).status).toBe('submitted');
    expect((await submit(c, b.id)).state.statusCode).toBe(409);
    expect(hold.submitEftBatch).toHaveBeenCalledTimes(1);
  });

  describe('a claim whose send is still in flight (round 3)', () => {
    /** Submit #1 parked inside the sender: its claim is 'pending'. `finish()` lets it answer. */
    async function inFlight() {
      const { c, b } = await freshBatch();
      let finish!: () => void;
      let entered!: () => void;
      const inSender = new Promise<void>((r) => { entered = r; });
      hold.submitEftBatch.mockImplementationOnce(async () => {
        entered();
        await new Promise<void>((r) => { finish = r; });
        return ACCEPTED;
      });
      const first = submit(c, b.id);
      await inSender;
      const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].id as string;
      const age = (minutes: number) => pool.query("UPDATE netcash_submissions SET created_at = NOW() - make_interval(mins => $2) WHERE id = $1", [id, minutes]);
      return { c, b, id, first, finish: () => finish(), age };
    }

    it('a young pending claim cannot be resolved: 409 in flight, and a second submit still sends nothing', async () => {
      const { c, b, id, first, finish } = await inFlight();
      const res = await resolve(u.admin, c, { submissionId: id, outcome: 'failed', note: NOTE });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
      expect(JSON.stringify(res.state.body)).toMatch(/in flight/i);
      expect((await row(id)).status).toBe('pending');
      expect((await submit(c, b.id)).state.statusCode).toBe(409);
      expect(hold.submitEftBatch).toHaveBeenCalledTimes(1);
      finish();
      expect((await first).state.statusCode).toBe(200);
      expect((await row(id)).status).toBe('submitted');
    });

    it('a pending claim older than the send window can be resolved (the process died)', async () => {
      const { c, id, first, finish, age } = await inFlight();
      await age(3);
      expect((await resolve(u.admin, c, { submissionId: id, outcome: 'failed', note: NOTE })).state.statusCode).toBe(200);
      finish();
      await first;
    });

    it('an unknown claim is resolvable at any age, even just created', async () => {
      const { c, id } = await unknownBatch();
      expect((await resolve(u.admin, c, { submissionId: id, outcome: 'failed', note: NOTE })).state.statusCode).toBe(200);
    });

    it('a settle that finds its claim resolved underneath it reports the conflict (409), never a 500, and keeps the late result', async () => {
      const { c, b, id, first, finish, age } = await inFlight();
      await age(3);
      expect((await resolve(u.admin, c, { submissionId: id, outcome: 'failed', note: NOTE })).state.statusCode).toBe(200);
      hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
      expect((await submit(c, b.id)).state.statusCode).toBe(200); // the operator's override let a second send through
      finish();
      const res = await first;
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
      expect(JSON.stringify(res.state.body)).toMatch(/resolved by an operator|check Netcash/i);
      const first_ = await row(id);
      expect(first_.status).toBe('failed'); // not overwritten
      expect(JSON.stringify(first_.netcash_response)).toContain('lateSendResult');
      expect((await pool.query("SELECT count(*)::INT AS n FROM netcash_submissions WHERE company_id = $1 AND status <> 'failed'", [c])).rows[0].n).toBe(1);
    });
  });
});
