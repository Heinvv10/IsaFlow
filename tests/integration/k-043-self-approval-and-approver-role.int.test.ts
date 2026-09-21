/**
 * K-043 RED: an approval request can be approved by the person who raised it,
 * and by someone who does not hold the rule's approver_role.
 *
 * src/modules/accounting/services/gl/approvalService.ts:230 decideRequest
 * filters on id, company_id and status='pending' only. It never reads
 * approval_rules.approver_role and never compares decided_by to requested_by.
 * pages/api/accounting/approval-requests.ts:71 passes the caller's own user id
 * straight through, and withWriteAccess admits any owner/admin/manager.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import type { NextApiRequest } from 'next';
import approvalRequests from '../../pages/api/accounting/approval-requests';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const requester = crypto.randomUUID();
const ruleId = crypto.randomUUID();
const requestId = crypto.randomUUID();
const documentId = crypto.randomUUID();
let token = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K043 company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'manager',true)",
    [requester, `k043-${requester}@test.local`]);
  // A manager: allowed to write, NOT the owner the rule demands as approver.
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'manager')", [company, requester]);
  await pool.query(
    `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active,priority)
     VALUES($1,$2,'K043 owner-only rule','supplier_invoice','total','greater_than',0,'owner',true,10)`,
    [ruleId, company]);
  await pool.query(
    `INSERT INTO approval_requests(id,company_id,rule_id,document_type,document_id,amount,status,requested_by)
     VALUES($1,$2,$3,'supplier_invoice',$4,250000,'pending',$5)`,
    [requestId, company, ruleId, documentId, requester]);
  token = await new SignJWT({ sub: requester, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM approval_requests WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM approval_rules WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [requester]);
  } finally { await pool.end(); }
});

it('refuses the requester approving their own request under an owner-only rule', async () => {
  const csrf = 'disposable-postgres-workflow-csrf-0123456789';
  const cookies = { 'sb-access-token': token, active_company_id: company, isaflow_csrf: csrf };
  const req = {
    method: 'POST', url: '/api/accounting/approval-requests', query: {}, cookies,
    headers: {
      cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      'x-csrf-token': csrf,
    },
    body: { action: 'approve', requestId, notes: 'approved by the requester' },
    socket: { remoteAddress: '127.0.0.84' },
  } as unknown as NextApiRequest;
  const result = response();

  await approvalRequests(req, result.res);

  // RED: the route answers 200 and the row is approved by its own requester.
  const { rows } = await pool.query('SELECT status, decided_by FROM approval_requests WHERE id=$1', [requestId]);
  expect(rows[0]).toMatchObject({ status: 'pending', decided_by: null });
  expect(result.state.statusCode).toBe(403);
});
