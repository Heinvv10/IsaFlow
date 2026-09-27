/**
 * R-035 re-check, through the real route.
 *
 * MEDIUM (PR1): re-stamping `requested_by` on a content change let the
 * content's AUTHOR shed the requester role: A requests, A edits, a colleague
 * re-requests, and A approves their own content as "not self". PR1 refused
 * every past requester; PR2 (Hein, 2026-09-27) refuses only the real authors —
 * the current requester and the content's author (last digest-moving editor,
 * or the creator) — so a past requester who wrote none of the current content
 * may approve. `past_requesters` is still recorded (types with no editor
 * tracking keep refusing it). The PR2 author cases are in
 * r035-pr2-authors.int.test.ts.
 *
 * LOW: a soft-deleted bill (`deleted_at` set) is no document at all — 404 on
 * decide, 400 on request.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import supplierInvoicesDetail from '../../pages/api/accounting/supplier-invoices-detail';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  callRoute, cleanup, createUser, newCompany, plantBill, plantRule, reasonOf,
} from './r035-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', c: '', owner2: '' };

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanup(pool, companies, Object.values(u)));

const URL = '/api/accounting/approval-requests';
const post = (as: string, company: string, body: unknown) => callRoute(approvalRequests, tokens[as]!, company, 'POST', body, URL);
const row = async (requestId: string) => (await pool.query(
  `SELECT status, requested_by, to_jsonb(ar) -> 'past_requesters' AS past, document_digest
   FROM approval_requests ar WHERE id = $1`,
  [requestId])).rows[0];
const approve = async (as: string, company: string, requestId: string) =>
  post(as, company, { action: 'approve', requestId, expectedDigest: (await row(requestId)).document_digest });

async function raise(as: string, company: string, billId: string) {
  return post(as, company, { action: 'request', documentType: 'supplier_invoice', documentId: billId });
}
/** A digest-moving edit through the detail PUT — records `as` as the content's author. */
const edit = (as: string, company: string, id: string) => callRoute(supplierInvoicesDetail, tokens[as]!, company, 'PUT',
  { id, invoiceDate: '2026-09-07' }, '/api/accounting/supplier-invoices-detail');
const idOf = (res: Awaited<ReturnType<typeof raise>>) => (res.state.body as { data: { id: string } }).data.id;

/** Every member an owner, so rank never decides these — only who requested. */
const company4 = () => newCompany(pool, [[u.a, 'owner'], [u.b, 'owner'], [u.c, 'owner'], [u.owner2, 'owner']], companies);

describe('past requesters and authors', () => {
  it('A requests, A edits, C re-requests: A authored the content and may not approve', async () => {
    const company = await company4();
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, u.b);
    const requestId = idOf(await raise(u.a, company, bill.id));
    expect((await edit(u.a, company, bill.id)).state.statusCode).toBe(200);
    await raise(u.c, company, bill.id);
    expect(await row(requestId)).toMatchObject({ requested_by: u.c, past: [u.a] });

    const decided = await approve(u.a, company, requestId);
    expect(decided.state.statusCode).toBe(403);
    expect(reasonOf(decided)).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await row(requestId)).status).toBe('pending');
    expect((await approve(u.owner2, company, requestId)).state.statusCode).toBe(200);
  });

  it('A requests, B edits and re-requests: B (requester and author) may not approve; A may', async () => {
    const company = await company4();
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, u.c);
    const requestId = idOf(await raise(u.a, company, bill.id));
    expect((await edit(u.b, company, bill.id)).state.statusCode).toBe(200);
    await raise(u.b, company, bill.id);

    expect(reasonOf(await approve(u.b, company, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await approve(u.a, company, requestId)).state.statusCode).toBe(200);
  });

  it('remembers every requester across several re-stamps, and a past requester who authored nothing may approve', async () => {
    const company = await company4();
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, u.owner2);
    const requestId = idOf(await raise(u.a, company, bill.id));
    for (const [by, total] of [[u.b, 2000], [u.c, 3000]] as const) {
      await pool.query('UPDATE supplier_invoices SET total_amount = $2 WHERE id = $1', [bill.id, total]);
      await raise(by, company, bill.id);
    }
    expect(await row(requestId)).toMatchObject({ requested_by: u.c, past: [u.a, u.b] });
    expect((await approve(u.b, company, requestId)).state.statusCode).toBe(200);
  });

  it('a past requester may still reject — only approve is the controlled act', async () => {
    const company = await company4();
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, u.a);
    const requestId = idOf(await raise(u.a, company, bill.id));
    await pool.query('UPDATE supplier_invoices SET total_amount = 2000 WHERE id = $1', [bill.id]);
    await raise(u.c, company, bill.id);
    expect((await post(u.a, company, { action: 'reject', requestId })).state.statusCode).toBe(200);
  });
});

describe('a soft-deleted bill is no document', () => {
  it('answers 404 on decide once the bill is soft-deleted', async () => {
    const company = await company4();
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, u.a);
    const requestId = idOf(await raise(u.a, company, bill.id));
    const expectedDigest = (await row(requestId)).document_digest;
    await pool.query('UPDATE supplier_invoices SET deleted_at = NOW() WHERE id = $1', [bill.id]);
    const decided = await post(u.owner2, company, { action: 'approve', requestId, expectedDigest });
    expect(decided.state.statusCode).toBe(404);
    expect((await row(requestId)).status).toBe('pending');
  });

  it('refuses to raise a request for a soft-deleted bill', async () => {
    const company = await company4();
    await plantRule(pool, company, 'owner');
    const bill = await plantBill(pool, company, u.a);
    await pool.query('UPDATE supplier_invoices SET deleted_at = NOW() WHERE id = $1', [bill.id]);
    expect((await raise(u.a, company, bill.id)).state.statusCode).toBe(400);
  });

  it('has no digest', async () => {
    const company = await company4();
    const bill = await plantBill(pool, company, u.a);
    await pool.query('UPDATE supplier_invoices SET deleted_at = NOW() WHERE id = $1', [bill.id]);
    const { rows } = await pool.query("SELECT approval_document_digest($1, 'supplier_invoice', $2) AS d", [company, bill.id]);
    expect(rows[0].d).toBeNull();
  });
});
