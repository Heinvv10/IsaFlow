/**
 * R-035 round-3 LOWs, through the real route.
 *
 * L1: the list → page → decide contract. The approvals page approves with the
 *     `documentDigest` the LIST returned; this drives exactly that path, so a
 *     list that stops carrying the digest breaks here, not only in the browser.
 * L2: approving requires the document to EXIST, independently of the digest.
 *     A bill soft-deleted before migration 708 with a pending request has a
 *     NULL stored AND live digest — equal, so the digest check alone let the
 *     approve through. Types with no digest definition had the same gap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, cleanup, createUser, newCompany, plantBill, plantRule } from './r035-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let requester = '';
let approver = '';

beforeAll(async () => {
  requester = await createUser(pool, tokens);
  approver = await createUser(pool, tokens);
});
afterAll(async () => {
  await pool.query('DELETE FROM credit_notes WHERE company_id = ANY($1)', [companies]);
  await cleanup(pool, companies, [requester, approver]);
});

const URL = '/api/accounting/approval-requests';
const call = (as: string, company: string, method: string, body: unknown, query: Record<string, string> = {}) =>
  callRoute(approvalRequests, tokens[as]!, company, method, body, URL, query);
const raise = async (company: string, documentType: string, documentId: string) =>
  ((await call(requester, company, 'POST', { action: 'request', documentType, documentId })).state.body as
    { data: { id: string } }).data.id;
const status = async (requestId: string) =>
  (await pool.query('SELECT status FROM approval_requests WHERE id = $1', [requestId])).rows[0].status as string;
const twoOwners = () => newCompany(pool, [[requester, 'owner'], [approver, 'owner']], companies);

describe('L1 — the approvals list carries what approve needs', () => {
  it('approves with the documentDigest the pending list returned — 200, row approved', async () => {
    const company = await twoOwners();
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, requester);
    const requestId = await raise(company, 'supplier_invoice', bill.id);

    const list = await call(approver, company, 'GET', undefined, { status: 'pending' });
    expect(list.state.statusCode).toBe(200);
    const item = (list.state.body as { data: { items: { id: string; documentDigest?: string }[] } })
      .data.items.find((i) => i.id === requestId);
    expect(item?.documentDigest).toMatch(/^[0-9a-f]{64}$/);

    const decided = await call(approver, company, 'POST', { action: 'approve', requestId, expectedDigest: item?.documentDigest });
    expect(decided.state.statusCode).toBe(200);
    expect(await status(requestId)).toBe('approved');
  });
});

describe('L2 — the document must exist, whatever the digest says', () => {
  it('answers 404 for a bill soft-deleted with a NULL-digest request (pre-708 shape)', async () => {
    const company = await twoOwners();
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, requester);
    const requestId = await raise(company, 'supplier_invoice', bill.id);
    await pool.query('UPDATE approval_requests SET document_digest = NULL WHERE id = $1', [requestId]);
    await pool.query('UPDATE supplier_invoices SET deleted_at = NOW() WHERE id = $1', [bill.id]);

    const decided = await call(approver, company, 'POST', { action: 'approve', requestId });
    expect(decided.state.statusCode).toBe(404);
    expect(await status(requestId)).toBe('pending');
  });

  it('answers 404 for a deleted document of a type with no digest definition', async () => {
    const company = await twoOwners();
    await plantRule(pool, company, 'owner', { documentType: 'credit_note' });
    const customer = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'r035 contract']);
    await pool.query(
      `INSERT INTO credit_notes(id,company_id,credit_note_number,type,client_id,credit_date,total_amount,created_by)
       VALUES($1,$2,$3,'customer',$4,CURRENT_DATE,100,$5)`, [noteId, company, `CN-${noteId.slice(0, 6)}`, customer, requester]);
    const requestId = await raise(company, 'credit_note', noteId);
    await pool.query('DELETE FROM credit_notes WHERE id = $1', [noteId]);

    const decided = await call(approver, company, 'POST', { action: 'approve', requestId });
    expect(decided.state.statusCode).toBe(404);
    expect(await status(requestId)).toBe('pending');
  });

  it('still lets a request whose document exists (and has no digest type) be approved', async () => {
    const company = await twoOwners();
    await plantRule(pool, company, 'owner', { documentType: 'credit_note' });
    const customer = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'r035 contract ok']);
    await pool.query(
      `INSERT INTO credit_notes(id,company_id,credit_note_number,type,client_id,credit_date,total_amount,created_by)
       VALUES($1,$2,$3,'customer',$4,CURRENT_DATE,100,$5)`, [noteId, company, `CN-${noteId.slice(0, 6)}`, customer, requester]);
    const requestId = await raise(company, 'credit_note', noteId);
    expect((await call(approver, company, 'POST', { action: 'approve', requestId })).state.statusCode).toBe(200);
  });
});
