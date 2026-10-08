/**
 * R-035 N1: approval_request_raise, _rebind and _lock, called DIRECTLY as
 * app_user. Raise computes everything but the document, the rule and the
 * requester itself, and binds only the strictest rule; rebind moves a request
 * only upwards; both bind the requester to the session user; lock answers only
 * for the request's own company.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupPr2 } from './r035-pr2.helpers';
import { asRole, n1Users, outcome, pendingBill, raiseFn, rebindFn, requestRow } from './r035-n1.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let u: Awaited<ReturnType<typeof n1Users>>;

beforeAll(async () => { u = await n1Users(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM impersonation_sessions WHERE actor_user_id = ANY($1)', [Object.values(u)]);
  await cleanupPr2(pool, companies, Object.values(u));
});

/** A bill with no request yet: the pending one pendingBill raised is withdrawn first. */
async function freshBill() {
  const f = await pendingBill(pool, tokens, u, companies);
  await pool.query('DELETE FROM approval_requests WHERE id = $1', [f.requestId]);
  return f;
}

const raise = (c: string, documentId: string, ruleId: string, by: string, opts: { sub?: string; sessionId?: string } = {}) =>
  asRole(pool, 'app_user', c, { sub: opts.sub ?? by, sessionId: opts.sessionId },
    async (cl) => (await raiseFn(cl, c, 'supplier_invoice', documentId, ruleId, by)).rows, true);

const rebind = (c: string, requestId: string, ruleId: string | null, by: string, opts: { sub?: string } = {}) =>
  asRole(pool, 'app_user', c, { sub: opts.sub ?? by }, async (cl) => (await rebindFn(cl, c, requestId, ruleId, by)).rows, true);

describe('approval_request_raise', () => {
  it('writes what requestApproval writes: the rule, its role, the live digest, the authors, the roster', async () => {
    const f = await freshBill();
    const [row] = await raise(f.c, f.bill.id, f.ownerRule, u.b);
    const { rows: [live] } = await pool.query(
      `SELECT approval_document_digest($1,'supplier_invoice',$2) AS digest, approval_document_authors($1,'supplier_invoice',$2) AS authors`,
      [f.c, f.bill.id]);
    expect(row).toMatchObject({ status: 'pending', rule_id: f.ownerRule, required_role: 'owner', requested_by: u.b,
      document_digest: live.digest, content_authors: live.authors, decided_by: null, past_requesters: [] });
    expect(Number(row.amount)).toBe(1150);
    expect(row.approver_roster).not.toBeNull();
  });

  it('refuses a laxer rule than the strictest one governing the document (RA009)', async () => {
    const f = await freshBill();
    expect(await outcome(raise(f.c, f.bill.id, f.managerRule, u.b))).toBe('RA009');
  });

  it('refuses a request raised in another user\'s name (RA009)', async () => {
    const f = await freshBill();
    expect(await outcome(raise(f.c, f.bill.id, f.ownerRule, u.a, { sub: u.b }))).toBe('RA009');
  });

  it('compares the subject as a uuid: the same id in upper case may raise', async () => {
    // Enforcement off: the roster snapshot (Q2, enforced types only) matches
    // the subject as text, through approval_company_other_members (708).
    const f = await freshBill();
    await pool.query('DELETE FROM approval_enforcement WHERE company_id = $1', [f.c]);
    expect(await raise(f.c, f.bill.id, f.ownerRule, u.b, { sub: u.b.toUpperCase() })).toHaveLength(1);
  });

  it('refuses a document of another company, or none (RA006), and writes nothing for an inactive rule', async () => {
    const f = await freshBill();
    const other = await freshBill();
    expect(await outcome(raise(f.c, other.bill.id, f.ownerRule, u.b))).toBe('RA006');
    await pool.query('UPDATE approval_rules SET is_active = false WHERE id = $1', [f.ownerRule]);
    expect(await raise(f.c, f.bill.id, f.ownerRule, u.b)).toEqual([]);
  });

  it('refuses a raise by a non-member, as RLS hid the document from findDocument (RA006)', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { members: [[u.a, 'owner'], [u.b, 'owner']] });
    await pool.query('DELETE FROM approval_requests WHERE id = $1', [f.requestId]);
    expect(await outcome(raise(f.c, f.bill.id, f.ownerRule, u.m))).toBe('RA006');
  });

  it('refuses a Login-as session (RA003)', async () => {
    const f = await freshBill();
    const sessionId = crypto.randomUUID();
    await pool.query('INSERT INTO impersonation_sessions(session_id, actor_user_id, target_user_id) VALUES($1,$2,$3)',
      [sessionId, u.v, u.b]);
    expect(await outcome(raise(f.c, f.bill.id, f.ownerRule, u.b, { sessionId }))).toBe('RA003');
  });

  it('a second pending request is still the 23505 requestApproval recovers from', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(raise(f.c, f.bill.id, f.ownerRule, u.b))).toBe('23505');
  });
});

describe('approval_request_rebind', () => {
  it('refuses to move a pending request onto a laxer rule (RA009)', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    await pool.query('UPDATE approval_rules SET is_active = false WHERE id = $1', [f.ownerRule]);
    expect(await outcome(rebind(f.c, f.requestId, f.managerRule, u.b))).toBe('RA009');
    expect(await requestRow(pool, f.requestId)).toMatchObject({ required_role: 'owner', rule_id: f.ownerRule });
  });

  it("refuses a rebind in another user's name (RA009)", async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(rebind(f.c, f.requestId, null, u.a, { sub: u.b }))).toBe('RA009');
  });

  it('re-stamps the requester only when the content moved, and keeps the binding without a rule', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await rebind(f.c, f.requestId, null, u.a)).toMatchObject([{ requested_by: u.b, past_requesters: [] }]);
    await pool.query("UPDATE supplier_invoices SET invoice_date = DATE '2026-09-08' WHERE id = $1", [f.bill.id]);
    expect(await rebind(f.c, f.requestId, null, u.a)).toMatchObject([
      { requested_by: u.a, past_requesters: [u.b], rule_id: f.ownerRule, required_role: 'owner' }]);
  });
});

describe('approval_request_lock', () => {
  it("locks only the request's own company (RA009 for another)", async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    const other = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(asRole(pool, 'app_user', f.c, { sub: u.b },
      (cl) => cl.query('SELECT approval_request_lock($1, $2)', [f.c, f.requestId])))).toBe('ok');
    expect(await outcome(asRole(pool, 'app_user', f.c, { sub: u.b },
      (cl) => cl.query('SELECT approval_request_lock($1, $2)', [other.c, other.requestId])))).toBe('RA009');
  });
});
