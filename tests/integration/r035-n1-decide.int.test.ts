/**
 * R-035 N1: approval_request_decide, called DIRECTLY as app_user — past every
 * TypeScript check — refuses what decideRequest refuses, with its own
 * SQLSTATE per class (RA001 self/author, RA002 rank/rule/membership, RA003
 * session, RA004 changed, RA005 digest missing, RA006 gone, RA009 forged), and
 * still decides what the app may decide: an eligible approver, a withdrawal,
 * and the Q2 sole approver.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupPr2, routes } from './r035-pr2.helpers';
import { asRole, decideFn, n1Users, outcome, pendingBill, requestRow } from './r035-n1.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let u: Awaited<ReturnType<typeof n1Users>>;
const r = routes(tokens);

beforeAll(async () => { u = await n1Users(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM impersonation_sessions WHERE actor_user_id = ANY($1)', [Object.values(u)]);
  await cleanupPr2(pool, companies, Object.values(u));
});

const digestOf = async (id: string) => (await requestRow(pool, id))?.document_digest ?? null;

/** decide `requestId` in company `c` as `by`, under `by`'s own claims unless `claims` says otherwise. */
const decide = async (c: string, requestId: string, by: string, decision = 'approved',
  opts: { sub?: string; sessionId?: string | null; expected?: string | null; company?: string } = {}) => {
  const expected = opts.expected === undefined ? await digestOf(requestId) : opts.expected;
  return asRole(pool, 'app_user', c, { sub: opts.sub ?? by, sessionId: opts.sessionId },
    async (cl) => (await decideFn(cl, opts.company ?? c, requestId, decision, by, expected)).rows, true);
};

describe('approval_request_decide refuses', () => {
  it('an under-rank decider (RA002), naming the role', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    await expect(decide(f.c, f.requestId, u.m)).rejects.toMatchObject({ code: 'RA002', message: 'This approval requires the owner role' });
    await expect(decide(f.c, f.requestId, u.m, 'rejected')).rejects.toMatchObject({ code: 'RA002' });
  });

  it('the requester while another member holds the rank (RA001)', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(decide(f.c, f.requestId, u.b))).toBe('RA001');
  });

  it('an author of the content (RA001)', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(decide(f.c, f.requestId, u.a))).toBe('RA001');
  });

  it('a decider who is no member: the row is as invisible as RLS makes it — nothing decided', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { members: [[u.a, 'owner'], [u.b, 'owner']] });
    expect(await decide(f.c, f.requestId, u.m)).toEqual([]);
    expect((await requestRow(pool, f.requestId))?.status).toBe('pending');
  });

  it('a request bound to a rule this company cannot see (RA002)', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m, requester: u.b });
    const other = await pendingBill(pool, tokens, u, companies);
    await pool.query('UPDATE approval_requests SET rule_id = $2 WHERE id = $1', [f.requestId, other.ownerRule]);
    await expect(decide(f.c, f.requestId, u.a)).rejects.toMatchObject({
      code: 'RA002', message: 'This approval names a rule that does not belong to this company and cannot be decided' });
  });

  it("another company's request: nothing found under its own company, forged under the other", async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    const other = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    expect(await decide(f.c, other.requestId, u.a)).toEqual([]);
    expect(await outcome(decide(f.c, other.requestId, u.a, 'approved', { company: other.c }))).toBe('RA009');
    expect((await requestRow(pool, other.requestId))?.status).toBe('pending');
  });

  it('a decided request: nothing is decided twice', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await decide(f.c, f.requestId, u.b, 'rejected')).toHaveLength(1); // the requester's withdrawal
    expect(await decide(f.c, f.requestId, u.b, 'rejected')).toEqual([]);
    expect((await requestRow(pool, f.requestId))?.status).toBe('rejected');
  });

  it('a digest the approver was not shown (RA004), none at all (RA005), or content that moved (RA004)', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    expect(await outcome(decide(f.c, f.requestId, u.a, 'approved', { expected: 'not-the-digest' }))).toBe('RA004');
    expect(await outcome(decide(f.c, f.requestId, u.a, 'approved', { expected: null }))).toBe('RA005');
    expect(await outcome(decide(f.c, f.requestId, u.a, 'approved', { expected: '' }))).toBe('RA005');
    await pool.query("UPDATE supplier_invoices SET invoice_date = DATE '2026-09-07' WHERE id = $1", [f.bill.id]);
    expect(await outcome(decide(f.c, f.requestId, u.a))).toBe('RA004');
  });

  it('a document that is gone (RA006)', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [f.bill.id]);
    expect(await outcome(decide(f.c, f.requestId, u.a))).toBe('RA006');
  });

  it('a Login-as session, and one that cannot be classified — approve and reject alike (RA003)', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    const sessionId = crypto.randomUUID();
    await pool.query('INSERT INTO impersonation_sessions(session_id, actor_user_id, target_user_id) VALUES($1,$2,$3)',
      [sessionId, u.v, u.a]);
    for (const decision of ['approved', 'rejected']) {
      expect(await outcome(decide(f.c, f.requestId, u.a, decision, { sessionId }))).toBe('RA003');
      expect(await outcome(decide(f.c, f.requestId, u.a, decision, { sessionId: null }))).toBe('RA003');
    }
  });

  it('a decider who is not the session user (RA009), and a decision that is neither (RA009)', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    expect(await outcome(decide(f.c, f.requestId, u.a, 'approved', { sub: u.m }))).toBe('RA009');
    expect(await outcome(decide(f.c, f.requestId, u.a, 'cancelled'))).toBe('RA009');
    expect((await requestRow(pool, f.requestId))?.status).toBe('pending');
  });
});

describe('approval_request_decide decides', () => {
  it('for an eligible approver: the row records them and the bill then posts', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m, requester: u.b });
    const [row] = await decide(f.c, f.requestId, u.a);
    expect(row).toMatchObject({ status: 'approved', decided_by: u.a, decision_notes: null });
    expect((await r.approveBill(u.m, f.c, f.bill.id)).state.statusCode).toBe(200);
  });

  it('Q2: a sole owner approves their own request', async () => {
    const f = await pendingBill(pool, tokens, u, companies,
      { members: [[u.a, 'owner'], [u.m, 'manager']], creator: u.a, requester: u.a });
    const [row] = await decide(f.c, f.requestId, u.a);
    expect(row).toMatchObject({ status: 'approved', decided_by: u.a, requested_by: u.a });
  });

  it('Q2 is refused once the roster moved since the request', async () => {
    const f = await pendingBill(pool, tokens, u, companies,
      { members: [[u.a, 'owner'], [u.m, 'manager']], creator: u.a, requester: u.a });
    await pool.query("UPDATE company_users SET role = 'accountant' WHERE company_id = $1 AND user_id = $2", [f.c, u.m]);
    expect(await outcome(decide(f.c, f.requestId, u.a))).toBe('RA001');
  });
});
