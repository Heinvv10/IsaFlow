/**
 * R-035 PR2-must (1), (3), (4): who may approve a supplier invoice.
 *
 * Refused as approver: the CURRENT requester (K-043, with the sole-approver
 * exception) and the content's AUTHOR — the last person whose edit changed
 * what the approval vouches for (the digest), or its creator when nobody has
 * edited it since. The author is recorded on every edit path (detail PUT, MCP
 * update_supplier_invoice, account merge) and snapshotted on the request when
 * it is raised or re-stamped. A PAST requester who did not author the current
 * content may approve (replaces PR1's blanket past-requester refusal).
 * Raising or re-requesting an approval under Login-as is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { updateSupplierInvoiceTool } from '../../src/lib/mcp/tools/writeUpdateSupplierInvoice';
import { mergeAccounts } from '../../src/modules/accounting/services/gl/accountMergeService';
import type { McpToolContext } from '../../src/lib/mcp/types';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantBill, plantRule, reasonOf, type Bill } from './r035-approval.helpers';
import { cleanupPr2, dataOf, enforce, impersonationToken, messageOf, postableCompany, routes } from './r035-pr2.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', c: '', d: '', admin: '' };
const r = routes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr2(pool, companies, Object.values(u)));

/** Four owners, so rank never decides these — only authorship. A creates every bill. */
async function fixture(): Promise<{ c: string; bill: Bill }> {
  const c = await postableCompany(pool, [[u.a, 'owner'], [u.b, 'owner'], [u.c, 'owner'], [u.d, 'owner']], companies);
  await plantRule(pool, c, 'owner');
  await enforce(pool, c, u.a);
  return { c, bill: await plantBill(pool, c, u.a) };
}

const idOf = (res: { state: { body: unknown } }) => dataOf<{ id: string }>(res).id;
async function raise(user: string, c: string, billId: string): Promise<string> {
  const res = await r.raise(user, c, billId);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return idOf(res);
}
const status = async (requestId: string) => (await pool.query(
  'SELECT status FROM approval_requests WHERE id = $1', [requestId])).rows[0].status as string;

/** Runs a service as `userId` in its own committed transaction, the way withAuth would. */
async function asUser<T>(userId: string, companyId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId, companyId, claims: {} } as never, fn);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('the content author may not approve', () => {
  it('A requests, B edits, A re-requests: B is refused, and told who may still approve', async () => {
    const { c, bill } = await fixture();
    const requestId = await raise(u.a, c, bill.id);
    expect((await r.editBill(u.b, c, { id: bill.id, invoiceDate: '2026-09-03' })).state.statusCode).toBe(200);
    expect(await raise(u.a, c, bill.id)).toBe(requestId);

    const decided = await r.decide(pool, u.b, c, requestId);
    expect(decided.state.statusCode).toBe(403);
    expect(reasonOf(decided)).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(messageOf(decided)).toMatch(/owner/);
    expect(messageOf(decided)).toMatch(/2 other members/);
    expect(await status(requestId)).toBe('pending');
    expect((await r.decide(pool, u.c, c, requestId)).state.statusCode).toBe(200);
  });

  it('A requests, B edits and re-requests: A did not author this content and MAY approve', async () => {
    const { c, bill } = await fixture();
    const requestId = await raise(u.a, c, bill.id);
    expect((await r.editBill(u.b, c, { id: bill.id, invoiceDate: '2026-09-03' })).state.statusCode).toBe(200);
    await raise(u.b, c, bill.id);
    const decided = await r.decide(pool, u.a, c, requestId);
    expect(decided.state.statusCode, JSON.stringify(decided.state.body)).toBe(200);
  });

  it('an MCP update_supplier_invoice line edit makes its caller the author', async () => {
    const { c, bill } = await fixture();
    const requestId = await raise(u.a, c, bill.id);
    const ctx = { companyId: c, userId: u.b, tokenJti: 'jti-r035' } as unknown as McpToolContext;
    const edited = await asUser(u.b, c, () => updateSupplierInvoiceTool.handler({
      invoice_id: bill.id, idempotency_key: `r035-${bill.id}`,
      // Same figures, recoded: a pending request pins the total, not the accounts.
      lines: [
        { description: 'Line A', quantity: 2, unit_price: 300, tax_rate: 15, gl_account_id: bill.accountB },
        { description: 'Line B', quantity: 1, unit_price: 400, tax_rate: 15, gl_account_id: bill.accountB },
      ],
    }, ctx));
    expect(edited.isError, JSON.stringify(edited)).toBeFalsy();
    await raise(u.a, c, bill.id);
    expect(reasonOf(await r.decide(pool, u.b, c, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('an account merge that repoints the bill lines makes the merger the author', async () => {
    const { c, bill } = await fixture();
    const requestId = await raise(u.a, c, bill.id);
    await asUser(u.b, c, () => mergeAccounts(c, bill.accountA, bill.accountB, u.b));
    await raise(u.a, c, bill.id);
    expect(reasonOf(await r.decide(pool, u.b, c, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('an edit that changes nothing the approval covers (notes) does not make an author', async () => {
    const { c, bill } = await fixture();
    const requestId = await raise(u.a, c, bill.id);
    expect((await r.editBill(u.b, c, { id: bill.id, notes: 'called the supplier' })).state.statusCode).toBe(200);
    expect((await r.decide(pool, u.b, c, requestId)).state.statusCode).toBe(200);
  });

  it('an edit reverted by someone else does not launder the author of the content requested', async () => {
    const { c, bill } = await fixture();
    expect((await r.editBill(u.b, c, { id: bill.id, invoiceDate: '2026-09-03' })).state.statusCode).toBe(200);
    const requestId = await raise(u.a, c, bill.id);
    expect((await r.editBill(u.c, c, { id: bill.id, invoiceDate: '2026-09-04' })).state.statusCode).toBe(200);
    expect((await r.editBill(u.c, c, { id: bill.id, invoiceDate: '2026-09-03' })).state.statusCode).toBe(200);
    expect(reasonOf(await r.decide(pool, u.b, c, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(reasonOf(await r.decide(pool, u.c, c, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await r.decide(pool, u.d, c, requestId)).state.statusCode).toBe(200);
  });

  it('a re-stamp re-snapshots the author, so a later edit-and-revert cannot launder it either', async () => {
    const { c, bill } = await fixture();
    const requestId = await raise(u.a, c, bill.id);
    expect((await r.editBill(u.b, c, { id: bill.id, invoiceDate: '2026-09-03' })).state.statusCode).toBe(200);
    await raise(u.a, c, bill.id);
    expect((await r.editBill(u.c, c, { id: bill.id, invoiceDate: '2026-09-04' })).state.statusCode).toBe(200);
    expect((await r.editBill(u.c, c, { id: bill.id, invoiceDate: '2026-09-03' })).state.statusCode).toBe(200);
    expect(reasonOf(await r.decide(pool, u.b, c, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await r.decide(pool, u.d, c, requestId)).state.statusCode).toBe(200);
  });

  it('the creator of never-edited content is its author', async () => {
    const { c, bill } = await fixture();
    const requestId = await raise(u.b, c, bill.id);
    expect(reasonOf(await r.decide(pool, u.a, c, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await r.decide(pool, u.c, c, requestId)).state.statusCode).toBe(200);
  });
});

describe('a bill created by no human (a system or agent identity)', () => {
  it('has no human author: only the requester is refused, and an eligible member approves', async () => {
    const { c } = await fixture();
    const system = '00000000-0000-0000-0000-000000000000';
    const bill = await plantBill(pool, c, system);
    expect((await pool.query("SELECT approval_document_author($1,'supplier_invoice',$2) AS a", [c, bill.id])).rows[0].a).toBe(system);
    const requestId = await raise(u.a, c, bill.id);
    expect(reasonOf(await r.decide(pool, u.a, c, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await r.decide(pool, u.b, c, requestId)).state.statusCode).toBe(200);
  });
});

describe('raising under Login-as (PR2-must 4)', () => {
  it('is refused 403 IMPERSONATION_FORBIDDEN, and nothing is written', async () => {
    const { c, bill } = await fixture();
    const token = await impersonationToken(pool, u.a, u.admin);
    const res = await callRoute(approvalRequests, token, c, 'POST',
      { action: 'request', documentType: 'supplier_invoice', documentId: bill.id }, '/api/accounting/approval-requests');
    expect(res.state.statusCode).toBe(403);
    expect(JSON.stringify(res.state.body)).toMatch(/IMPERSONATION_FORBIDDEN/);
    expect((await pool.query('SELECT count(*)::INT AS n FROM approval_requests WHERE document_id = $1', [bill.id])).rows[0].n).toBe(0);
  });

  it('a re-request under Login-as is refused and leaves the pending request as it was', async () => {
    const { c, bill } = await fixture();
    const requestId = await raise(u.b, c, bill.id);
    await pool.query('UPDATE supplier_invoices SET total_amount = 2000 WHERE id = $1', [bill.id]);
    const token = await impersonationToken(pool, u.c, u.admin);
    const res = await callRoute(approvalRequests, token, c, 'POST',
      { action: 'request', documentType: 'supplier_invoice', documentId: bill.id }, '/api/accounting/approval-requests');
    expect(res.state.statusCode).toBe(403);
    const { rows } = await pool.query('SELECT requested_by FROM approval_requests WHERE id = $1', [requestId]);
    expect(rows[0].requested_by).toBe(u.b);
  });
});
