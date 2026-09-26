/**
 * R-035 PR1 through the real approval-requests route:
 *
 *  1. The request stores the document's digest; approving after the document
 *     changed is a 409 DOCUMENT_CHANGED, and re-requesting refreshes the digest.
 *  2. Sole-approver self-approval (Hein, decision Q2): a requester may approve
 *     their OWN request only when no OTHER active member of the company holds
 *     the demanded rank. It is audited with a distinct marker and every other
 *     check (rank, digest) still applies. The K-043 ban holds otherwise.
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
let owner = '';
let owner2 = '';
let admin = '';
let manager = '';

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  owner2 = await createUser(pool, tokens);
  admin = await createUser(pool, tokens);
  manager = await createUser(pool, tokens);
});
afterAll(() => cleanup(pool, companies, [owner, owner2, admin, manager]));

const URL = '/api/accounting/approval-requests';
const post = (as: string, company: string, body: unknown) => callRoute(approvalRequests, tokens[as]!, company, 'POST', body, URL);
const stored = async (requestId: string) => (await pool.query(
  'SELECT status, decided_by, document_digest FROM approval_requests WHERE id = $1', [requestId])).rows[0];
const liveDigest = async (company: string, billId: string) => (await pool.query(
  "SELECT approval_document_digest($1, 'supplier_invoice', $2) AS d", [company, billId])).rows[0].d as string;

async function raise(as: string, company: string, billId: string): Promise<string> {
  const raised = await post(as, company, { action: 'request', documentType: 'supplier_invoice', documentId: billId });
  expect(raised.state.statusCode).toBe(200);
  return (raised.state.body as { data: { id: string } }).data.id;
}

describe('approving binds to the content that was requested', () => {
  it('stores the digest of the document when the request is raised', async () => {
    const company = await newCompany(pool, [[admin, 'admin'], [owner, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, admin);
    const requestId = await raise(admin, company, bill.id);
    const row = await stored(requestId);
    expect(row.document_digest).toMatch(/^[0-9a-f]{32}$/);
    expect(row.document_digest).toBe(await liveDigest(company, bill.id));
  });

  it('refuses approve with 409 DOCUMENT_CHANGED after the bill was edited, and leaves it pending', async () => {
    const company = await newCompany(pool, [[admin, 'admin'], [owner, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, admin);
    const requestId = await raise(admin, company, bill.id);
    await pool.query("UPDATE supplier_invoices SET invoice_date = DATE '2026-09-02' WHERE id = $1", [bill.id]);

    const approve = await post(owner, company, { action: 'approve', requestId });
    expect(approve.state.statusCode).toBe(409);
    expect(reasonOf(approve)).toBe('DOCUMENT_CHANGED');
    expect((await stored(requestId)).status).toBe('pending');
  });

  it('lets a re-request refresh the digest, after which the approve goes through', async () => {
    const company = await newCompany(pool, [[admin, 'admin'], [owner, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, admin);
    const requestId = await raise(admin, company, bill.id);
    await pool.query("UPDATE supplier_invoice_items SET line_total = 650 WHERE supplier_invoice_id = $1 AND description = 'Line A'", [bill.id]);

    expect(await raise(admin, company, bill.id)).toBe(requestId);
    expect((await stored(requestId)).document_digest).toBe(await liveDigest(company, bill.id));
    const approve = await post(owner, company, { action: 'approve', requestId });
    expect(approve.state.statusCode).toBe(200);
    expect((await stored(requestId)).status).toBe('approved');
  });

  it('refreshes the digest on re-request even when no rule governs the bill any more', async () => {
    // The rebind keeps a pending request's authority when today's rule is laxer
    // or gone, but its CONTENT binding must follow the bill — else every approve
    // is DOCUMENT_CHANGED and re-requesting cannot fix it.
    const company = await newCompany(pool, [[admin, 'admin'], [owner, 'owner']], companies);
    const rule = await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, admin);
    const requestId = await raise(admin, company, bill.id);
    await pool.query('UPDATE approval_rules SET is_active = false WHERE id = $1', [rule]);
    await pool.query('UPDATE supplier_invoices SET total_amount = 2000 WHERE id = $1', [bill.id]);

    expect(await raise(admin, company, bill.id)).toBe(requestId);
    const row = (await pool.query('SELECT required_role, document_digest FROM approval_requests WHERE id = $1', [requestId])).rows[0];
    expect(row.required_role).toBe('owner');
    expect(row.document_digest).toBe(await liveDigest(company, bill.id));
    expect((await post(owner, company, { action: 'approve', requestId })).state.statusCode).toBe(200);
  });

  it('approves again once the edit is reverted to identical content (Q9)', async () => {
    const company = await newCompany(pool, [[admin, 'admin'], [owner, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, admin);
    const requestId = await raise(admin, company, bill.id);
    await pool.query('UPDATE supplier_invoices SET total_amount = 2000 WHERE id = $1', [bill.id]);
    expect((await post(owner, company, { action: 'approve', requestId })).state.statusCode).toBe(409);
    await pool.query('UPDATE supplier_invoices SET total_amount = 1150 WHERE id = $1', [bill.id]);
    expect((await post(owner, company, { action: 'approve', requestId })).state.statusCode).toBe(200);
  });

  it('does not block a REJECT on a changed document — only approve is the controlled act', async () => {
    const company = await newCompany(pool, [[admin, 'admin'], [owner, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, admin);
    const requestId = await raise(admin, company, bill.id);
    await pool.query('UPDATE supplier_invoices SET total_amount = 2000 WHERE id = $1', [bill.id]);
    expect((await post(owner, company, { action: 'reject', requestId })).state.statusCode).toBe(200);
    expect((await stored(requestId)).status).toBe('rejected');
  });
});

const auditRows = async (company: string, requestId: string) => (await pool.query(
  `SELECT action, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'approval_request' AND entity_id = $2`,
  [company, requestId])).rows;

describe('sole-approver self-approval (Q2)', () => {
  it('lets the ONLY owner approve their own owner-only request, and audits it distinctly', async () => {
    const company = await newCompany(pool, [[owner, 'owner'], [admin, 'admin'], [manager, 'manager']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, owner);
    const requestId = await raise(owner, company, bill.id);

    const approve = await post(owner, company, { action: 'approve', requestId });
    expect(approve.state.statusCode).toBe(200);
    expect(await stored(requestId)).toMatchObject({ status: 'approved', decided_by: owner });
    const audit = await auditRows(company, requestId);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('approve');
    expect(audit[0].changes.metadata).toMatchObject({ selfApproval: 'sole_approver', requiredRole: 'owner' });
  });

  it('refuses it — SELF_APPROVAL_FORBIDDEN — when another active owner exists', async () => {
    const company = await newCompany(pool, [[owner, 'owner'], [owner2, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, owner);
    const requestId = await raise(owner, company, bill.id);

    const approve = await post(owner, company, { action: 'approve', requestId });
    expect(approve.state.statusCode).toBe(403);
    expect(reasonOf(approve)).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await stored(requestId)).status).toBe('pending');
    expect(await auditRows(company, requestId)).toHaveLength(0);
  });

  it('counts a higher rank as eligible: an admin rule with an owner present is refused to the admin', async () => {
    const company = await newCompany(pool, [[admin, 'admin'], [owner, 'owner']], companies);
    await plantRule(pool, company, 'admin');
    const bill = await plantBill(pool, company, admin);
    const requestId = await raise(admin, company, bill.id);
    const approve = await post(admin, company, { action: 'approve', requestId });
    expect(approve.state.statusCode).toBe(403);
    expect(reasonOf(approve)).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('does not count a suspended member as another approver', async () => {
    const suspended = await createUser(pool, tokens);
    await pool.query('UPDATE users SET is_active = false, suspended_at = NOW() WHERE id = $1', [suspended]);
    const company = await newCompany(pool, [[owner, 'owner'], [suspended, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, owner);
    const requestId = await raise(owner, company, bill.id);
    expect((await post(owner, company, { action: 'approve', requestId })).state.statusCode).toBe(200);
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [suspended]);
    await pool.query('DELETE FROM users WHERE id = $1', [suspended]);
  });

  it('still applies the rank check: a sole manager cannot self-approve an owner-only request', async () => {
    const company = await newCompany(pool, [[manager, 'manager']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, manager);
    const requestId = await raise(manager, company, bill.id);
    const approve = await post(manager, company, { action: 'approve', requestId });
    expect(approve.state.statusCode).toBe(403);
    expect(reasonOf(approve)).toBe('APPROVER_ROLE_REQUIRED');
    expect((await stored(requestId)).status).toBe('pending');
  });

  it('still applies the digest check to a sole-approver self-approval', async () => {
    const company = await newCompany(pool, [[owner, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, owner);
    const requestId = await raise(owner, company, bill.id);
    await pool.query('UPDATE supplier_invoices SET total_amount = 2000 WHERE id = $1', [bill.id]);
    const approve = await post(owner, company, { action: 'approve', requestId });
    expect(approve.state.statusCode).toBe(409);
    expect(reasonOf(approve)).toBe('DOCUMENT_CHANGED');
    expect(await auditRows(company, requestId)).toHaveLength(0);
  });

  it("counts only THIS company's members: another company's owner does not make the requester non-sole", async () => {
    const company = await newCompany(pool, [[owner, 'owner']], companies);
    await newCompany(pool, [[owner2, 'owner'], [owner, 'owner']], companies);
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, owner);
    const requestId = await raise(owner, company, bill.id);
    expect((await post(owner, company, { action: 'approve', requestId })).state.statusCode).toBe(200);
  });
});
