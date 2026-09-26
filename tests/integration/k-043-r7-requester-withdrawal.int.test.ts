/**
 * K-043 round-7 LOW-3: the ratchet made R-033 unclearable in BOTH directions.
 *
 * Before migration 669 a request whose demanded role only the requester held
 * had one escape: relax the bound rule, then let a lower rank decide. The
 * ratchet closes that — correctly — and there is no cancel or withdraw action
 * anywhere, so the row could be neither approved (self) nor rejected (rank) by
 * anybody, and stayed pending forever. It is not confined to sole-owner
 * companies: it fires whenever the only actor holding the snapshot rank is the
 * requester.
 *
 * The remedy costs no security: only APPROVE is the controlled act. Rejecting
 * your own request is a withdrawal — it grants nothing — so `assertMayDecide`
 * permits it, and permits it without an approver rank, which is what makes the
 * state escapable for a requester who ranks below their own request's demand.
 * Everything else stays exactly as round 6 left it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approvalRules from '../../pages/api/accounting/approval-rules';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { deletePlantedDocuments, plantDocument } from './approval-document.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const admin = crypto.randomUUID();
const manager = crypto.randomUUID();
const owner = crypto.randomUUID();
const users = [admin, manager, owner];
const tokens: Record<string, string> = {};

const sign = (id: string) => new SignJWT({ sub: id, aal: 'aal2' })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(process.env.JWT_SECRET));

beforeAll(async () => {
  for (const id of users) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
      [id, `${id}@test.local`]);
    tokens[id] = await sign(id);
  }
});

async function newCompany(): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, `K043r7 ${id.slice(0, 8)}`]);
  for (const [userId, role] of [[admin, 'admin'], [manager, 'manager'], [owner, 'owner']] as const) {
    await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [id, userId, role]);
  }
  companies.push(id);
  return id;
}

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM approval_requests WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM approval_rules WHERE company_id=ANY($1)', [companies]);
    await deletePlantedDocuments(pool, companies);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [companies]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [users]);
  } finally {
    await pool.end();
  }
});

function call(handler: typeof approvalRules, as: string, companyId: string, method: string, body: unknown) {
  const req = request({ 'sb-access-token': tokens[as]!, active_company_id: companyId }, method) as never as {
    body: unknown; query: Record<string, string>; url: string;
  };
  req.body = body;
  req.query = {};
  req.url = '/api/accounting/approval-requests';
  const result = response();
  return handler(req as never, result.res).then(() => result);
}

const reasonOf = (result: Awaited<ReturnType<typeof call>>) =>
  (result.state.body as { error?: { details?: { reason?: string } } }).error?.details?.reason;

async function plantRule(companyId: string, name: string, approverRole: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
     VALUES($1,$2,$3,'supplier_invoice','amount','any',0,$4,true)`, [id, companyId, name, approverRole]);
  return id;
}

const storedRequest = async (documentId: string) => (await pool.query(
  'SELECT id, status, required_role, decided_by FROM approval_requests WHERE document_id=$1', [documentId])).rows[0];

/** The R-033 shape: the requester is the only actor holding the demanded rank. */
async function ownerRaisedOwnerOnly(): Promise<{ company: string; rule: string; documentId: string; requestId: string }> {
  const company = await newCompany();
  const rule = await plantRule(company, 'r7 owner any', 'owner');
  const documentId = await plantDocument(pool, company, 'supplier_invoice', 500000, owner);
  const raised = await call(approvalRequests, owner, company, 'POST', {
    action: 'request', documentType: 'supplier_invoice', documentId,
  });
  expect(raised.state.statusCode).toBe(200);
  const stored = await storedRequest(documentId);
  expect(stored.required_role).toBe('owner');
  return { company, rule, documentId, requestId: stored.id as string };
}

describe('R-033 — the requester may withdraw a request nobody else can clear', () => {
  it('lets the owner reject their own request after the ratchet has locked every other route', async () => {
    const { company, rule, documentId, requestId } = await ownerRaisedOwnerOnly();

    // The legitimate relaxation that used to be the escape hatch.
    const relaxed = await call(approvalRules, owner, company, 'PUT', { id: rule, approverRole: 'manager' });
    expect(relaxed.state.statusCode).toBe(200);

    // Every route round 6 leaves closed, still closed.
    const selfApprove = await call(approvalRequests, owner, company, 'POST', { action: 'approve', requestId });
    expect(selfApprove.state.statusCode).toBe(403);
    expect(reasonOf(selfApprove)).toBe('SELF_APPROVAL_FORBIDDEN');
    const byAdmin = await call(approvalRequests, admin, company, 'POST', { action: 'approve', requestId });
    expect(byAdmin.state.statusCode).toBe(403);
    expect(reasonOf(byAdmin)).toBe('APPROVER_ROLE_REQUIRED');
    const byManager = await call(approvalRequests, manager, company, 'POST', { action: 'approve', requestId });
    expect(byManager.state.statusCode).toBe(403);
    expect(reasonOf(byManager)).toBe('APPROVER_ROLE_REQUIRED');

    // The one route that opens: the requester withdraws.
    const withdrawn = await call(approvalRequests, owner, company, 'POST', {
      action: 'reject', requestId, notes: 'withdrawn',
    });
    expect(withdrawn.state.statusCode).toBe(200);
    const after = await storedRequest(documentId);
    expect(after.status).toBe('rejected');
    expect(after.decided_by).toBe(owner);
  });

  it('lets a requester who ranks BELOW their own request withdraw it', async () => {
    // The rank check is SKIPPED for a withdrawal, not merely satisfied: the
    // manager ranks 4 and the snapshot demands owner, rank 7. (The requester is
    // a manager rather than something lower because withWriteAccess is what
    // bounds who can reach this route at all.)
    const company = await newCompany();
    await plantRule(company, 'r7 owner any', 'owner');
    const documentId = await plantDocument(pool, company, 'supplier_invoice', 500000, manager);
    const raised = await call(approvalRequests, manager, company, 'POST', {
      action: 'request', documentType: 'supplier_invoice', documentId,
    });
    expect(raised.state.statusCode).toBe(200);
    const stored = await storedRequest(documentId);
    expect(stored.required_role).toBe('owner');

    const withdrawn = await call(approvalRequests, manager, company, 'POST', {
      action: 'reject', requestId: stored.id,
    });
    expect(withdrawn.state.statusCode).toBe(200);
    expect((await storedRequest(documentId)).status).toBe('rejected');
  });
});

describe('what the withdrawal must NOT open', () => {
  it('still refuses the requester their own APPROVE', async () => {
    const { company, requestId, documentId } = await ownerRaisedOwnerOnly();
    const selfApprove = await call(approvalRequests, owner, company, 'POST', { action: 'approve', requestId });
    expect(selfApprove.state.statusCode).toBe(403);
    expect(reasonOf(selfApprove)).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await storedRequest(documentId)).status).toBe('pending');
  });

  it('still rank-checks a REJECT taken by someone other than the requester', async () => {
    // Rejecting is only unconditional for the requester. For anybody else it is
    // a decision on someone else's document and keeps the snapshot's demand.
    const { company, requestId, documentId } = await ownerRaisedOwnerOnly();
    const byManager = await call(approvalRequests, manager, company, 'POST', { action: 'reject', requestId });
    expect(byManager.state.statusCode).toBe(403);
    expect(reasonOf(byManager)).toBe('APPROVER_ROLE_REQUIRED');
    expect((await storedRequest(documentId)).status).toBe('pending');
  });

  it("refuses a foreign company's context for the same withdrawal", async () => {
    const { requestId, documentId } = await ownerRaisedOwnerOnly();
    const other = await newCompany();
    const foreign = await call(approvalRequests, owner, other, 'POST', { action: 'reject', requestId });
    expect(foreign.state.statusCode).toBe(404);
    expect((await storedRequest(documentId)).status).toBe('pending');
  });
});
