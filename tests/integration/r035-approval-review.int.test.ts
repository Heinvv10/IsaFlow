/**
 * R-035 PR1 review round (blind review, REQUEST_CHANGES) through the real route:
 *
 *  HIGH  An editor who re-requests becomes the requester. A raises, B edits the
 *        bill and re-requests; the rebind refreshed the digest but kept A as
 *        requester, so B approved their own edit as "not self".
 *  MED-1 Sole-approver self-approval (Q2) applies only where enforcement is ON
 *        for the type, only when the company roster is unchanged since the
 *        request (snapshot at request time), and the audit row carries it.
 *  MED-2 Approve must carry `expectedDigest` — the digest the approver was shown.
 *  LOW-3 A deleted document is a 404; a request with no digest heals on re-request.
 *  LOW-5 system / super_admin members count as other approvers (fails closed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  callRoute, cleanup, createUser, newCompany, plantBill, plantRule, reasonOf,
} from './r035-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u: Record<'a' | 'b' | 'owner' | 'owner2' | 'admin' | 'sys', string> = {
  a: '', b: '', owner: '', owner2: '', admin: '', sys: '',
};

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanup(pool, companies, Object.values(u)));

const URL = '/api/accounting/approval-requests';
const post = (as: string, company: string, body: unknown) => callRoute(approvalRequests, tokens[as]!, company, 'POST', body, URL);
const row = async (requestId: string) => (await pool.query(
  'SELECT status, requested_by, requested_at, document_digest FROM approval_requests WHERE id = $1',
  [requestId])).rows[0];
const rosterOf = async (requestId: string) => (await pool.query(
  'SELECT approver_roster FROM approval_requests WHERE id = $1', [requestId])).rows[0].approver_roster;
const approve = async (as: string, company: string, requestId: string) =>
  post(as, company, { action: 'approve', requestId, expectedDigest: (await row(requestId)).document_digest });
const enforce = (company: string) => pool.query(
  "INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,'supplier_invoice',$2)", [company, u.owner]);

async function raise(as: string, company: string, billId: string): Promise<string> {
  const raised = await post(as, company, { action: 'request', documentType: 'supplier_invoice', documentId: billId });
  expect(raised.state.statusCode).toBe(200);
  return (raised.state.body as { data: { id: string } }).data.id;
}

describe('HIGH — whoever re-requests a changed document becomes its requester', () => {
  it('refuses B approving after B edited and re-requested A\'s request', async () => {
    const company = await newCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.owner2, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, u.a);
    const requestId = await raise(u.a, company, bill.id);
    const before = await row(requestId);
    await pool.query('UPDATE supplier_invoices SET total_amount = 2000 WHERE id = $1', [bill.id]);

    expect(await raise(u.b, company, bill.id)).toBe(requestId);
    const after = await row(requestId);
    expect(after.requested_by).toBe(u.b);
    expect(new Date(after.requested_at).getTime()).toBeGreaterThan(new Date(before.requested_at).getTime());

    const decided = await approve(u.b, company, requestId);
    expect(decided.state.statusCode).toBe(403);
    expect(reasonOf(decided)).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await row(requestId)).status).toBe('pending');
  });

  it('keeps the requester when a re-request moves the request to a stricter rule without a content change', async () => {
    const company = await newCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
    await plantRule(pool, company, 'admin');
    const bill = await plantBill(pool, company, u.a);
    const requestId = await raise(u.a, company, bill.id);
    await plantRule(pool, company, 'owner');
    await raise(u.b, company, bill.id);
    const after = (await pool.query('SELECT requested_by, required_role FROM approval_requests WHERE id = $1', [requestId])).rows[0];
    expect(after).toEqual({ requested_by: u.a, required_role: 'owner' });
    expect((await approve(u.b, company, requestId)).state.statusCode).toBe(200);
  });

  it('keeps the original requester when a re-request changes nothing', async () => {
    const company = await newCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, u.a);
    const requestId = await raise(u.a, company, bill.id);
    await raise(u.b, company, bill.id);
    expect((await row(requestId)).requested_by).toBe(u.a);
    expect((await approve(u.b, company, requestId)).state.statusCode).toBe(200);
  });
});

const auditMeta = async (company: string, requestId: string) => (await pool.query(
  `SELECT changes->'metadata' AS m FROM audit_log WHERE company_id = $1 AND entity_type = 'approval_request' AND entity_id = $2`,
  [company, requestId])).rows.map((r) => r.m);

describe('MED-1 — sole-approver self-approval is narrow and evidenced', () => {
  it('is NOT available while enforcement is off for the type (PR1: everywhere)', async () => {
    const company = await newCompany(pool, [[u.owner, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const requestId = await raise(u.owner, company, (await plantBill(pool, company, u.owner)).id);
    const decided = await approve(u.owner, company, requestId);
    expect(decided.state.statusCode).toBe(403);
    expect(reasonOf(decided)).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('is withdrawn when enforcement is switched off after the request', async () => {
    const company = await newCompany(pool, [[u.owner, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    await enforce(company);
    const requestId = await raise(u.owner, company, (await plantBill(pool, company, u.owner)).id);
    await pool.query('DELETE FROM approval_enforcement WHERE company_id = $1', [company]);
    expect(reasonOf(await approve(u.owner, company, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('is refused for a request raised BEFORE enforcement was on (no roster snapshot)', async () => {
    const company = await newCompany(pool, [[u.owner, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const requestId = await raise(u.owner, company, (await plantBill(pool, company, u.owner)).id);
    expect(await rosterOf(requestId)).toBeNull();
    await enforce(company);
    expect(reasonOf(await approve(u.owner, company, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('is refused when the roster was engineered by demotion after the request', async () => {
    const company = await newCompany(pool, [[u.owner, 'owner'], [u.owner2, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    await enforce(company);
    const requestId = await raise(u.owner, company, (await plantBill(pool, company, u.owner)).id);
    await pool.query("UPDATE company_users SET role = 'manager' WHERE company_id = $1 AND user_id = $2", [company, u.owner2]);
    const decided = await approve(u.owner, company, requestId);
    expect(decided.state.statusCode).toBe(403);
    expect(reasonOf(decided)).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await row(requestId)).status).toBe('pending');
  });

  it("is refused when the requester's OWN role changed after the request", async () => {
    const company = await newCompany(pool, [[u.admin, 'admin'], [u.a, 'manager']], companies);
    await plantRule(pool, company, 'admin');
    await enforce(company);
    const requestId = await raise(u.admin, company, (await plantBill(pool, company, u.admin)).id);
    await pool.query("UPDATE company_users SET role = 'owner' WHERE company_id = $1 AND user_id = $2", [company, u.admin]);
    expect(reasonOf(await approve(u.admin, company, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('re-snapshots the roster for a re-requester, who may then self-approve as the sole approver', async () => {
    const company = await newCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    await enforce(company);
    const bill = await plantBill(pool, company, u.a);
    const requestId = await raise(u.a, company, bill.id);
    await pool.query('UPDATE supplier_invoices SET total_amount = 2000 WHERE id = $1', [bill.id]);
    await raise(u.b, company, bill.id);
    expect((await rosterOf(requestId)).requester_role).toBe('owner');
    expect((await approve(u.b, company, requestId)).state.statusCode).toBe(200);
  });

  it('records the roster snapshot — ids and roles of every other member — on the audit row', async () => {
    const company = await newCompany(pool, [[u.owner, 'owner'], [u.admin, 'admin']], companies);
    await plantRule(pool, company, 'owner');
    await enforce(company);
    const requestId = await raise(u.owner, company, (await plantBill(pool, company, u.owner)).id);
    expect((await approve(u.owner, company, requestId)).state.statusCode).toBe(200);
    const [meta] = await auditMeta(company, requestId);
    expect(meta.selfApproval).toBe('sole_approver');
    const roster = JSON.parse(meta.approverRoster);
    expect(roster.requester_role).toBe('owner');
    expect(roster.others).toEqual([expect.objectContaining({ user_id: u.admin, role: 'admin' })]);
  });
});

describe('LOW-5 — platform roles count as other approvers (fails closed)', () => {
  it.each([['system', 'admin'], ['super_admin', 'owner']])(
    'a %s member blocks sole-approver self-approval of an %s rule', async (platformRole, ruleRole) => {
      const requester = ruleRole === 'owner' ? u.owner : u.admin;
      const company = await newCompany(pool, [[requester, ruleRole], [u.sys, platformRole]], companies);
      await plantRule(pool, company, ruleRole);
      await enforce(company);
      const requestId = await raise(requester, company, (await plantBill(pool, company, requester)).id);
      expect(reasonOf(await approve(requester, company, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
    });
});

describe('MED-2 — approve names the digest the approver saw', () => {
  it('refuses an approve with no expectedDigest — 400 EXPECTED_DIGEST_REQUIRED', async () => {
    const company = await newCompany(pool, [[u.a, 'admin'], [u.owner, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const requestId = await raise(u.a, company, (await plantBill(pool, company, u.a)).id);
    const decided = await post(u.owner, company, { action: 'approve', requestId });
    expect(decided.state.statusCode).toBe(400);
    expect(reasonOf(decided)).toBe('EXPECTED_DIGEST_REQUIRED');
    expect((await row(requestId)).status).toBe('pending');
  });

  it('refuses a stale expectedDigest — 409 DOCUMENT_CHANGED — even when the bill is unchanged', async () => {
    const company = await newCompany(pool, [[u.a, 'admin'], [u.owner, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const requestId = await raise(u.a, company, (await plantBill(pool, company, u.a)).id);
    const decided = await post(u.owner, company, { action: 'approve', requestId, expectedDigest: 'f'.repeat(64) });
    expect(decided.state.statusCode).toBe(409);
    expect(reasonOf(decided)).toBe('DOCUMENT_CHANGED');
  });
});

describe('LOW-3 — deleted documents and requests raised without a digest', () => {
  it('answers 404 when the document was deleted after the request', async () => {
    const company = await newCompany(pool, [[u.a, 'admin'], [u.owner, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, u.a);
    const requestId = await raise(u.a, company, bill.id);
    const expectedDigest = (await row(requestId)).document_digest;
    await pool.query('DELETE FROM supplier_invoices WHERE id = $1', [bill.id]);
    const decided = await post(u.owner, company, { action: 'approve', requestId, expectedDigest });
    expect(decided.state.statusCode).toBe(404);
  });

  it('heals a NULL-digest request (raised in the deploy window) on re-request', async () => {
    const company = await newCompany(pool, [[u.a, 'admin'], [u.owner, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, u.a);
    const requestId = await raise(u.a, company, bill.id);
    await pool.query('UPDATE approval_requests SET document_digest = NULL WHERE id = $1', [requestId]);
    expect(reasonOf(await approve(u.owner, company, requestId))).toBe('DOCUMENT_CHANGED');
    await raise(u.a, company, bill.id);
    expect((await row(requestId)).document_digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await approve(u.owner, company, requestId)).state.statusCode).toBe(200);
  });
});
