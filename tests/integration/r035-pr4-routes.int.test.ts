/**
 * R-035 PR4: the customer-invoice routes around the approve action.
 *
 *  - The detail GET carries the DERIVED approval state while the invoice is a
 *    draft or pending approval, null once it is posted.
 *  - The detail PUT (the draft edit) moves approval content: an approval goes
 *    STALE, the editor becomes an author (refused as its approver), an edit to
 *    what an approval does not cover (notes) makes nobody an author, and
 *    putting the content back clears the approval again (Q9).
 *  - The customer merge re-points an invoice's customer — approval content —
 *    so the same holds for the merging user (Q10).
 *  - The legacy "Post to GL" (customer-invoices-gl) stays ungated (Q7): it
 *    still refuses a draft (R-118) and posts an approved invoice with no
 *    journal under enforcement.
 *  - The Enforce switch's preview counts the draft / pending invoices it holds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import customerInvoicesGl from '../../pages/api/accounting/customer-invoices-gl';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import {
  cleanupPr4, digestOf, enforceInvoices, invoiceCompany, invoiceRoutes, invoiceState, plantInvoice,
} from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', c: '', m: '' };
const r = invoiceRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr4(pool, companies, Object.values(u)));

/** A (admin) books; B and C (owners) approve; M is a manager. */
async function gatedCompany(): Promise<string> {
  const c = await invoiceCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.c, 'owner'], [u.m, 'manager']], companies);
  await plantRule(pool, c, 'owner', { documentType: 'customer_invoice', name: 'Owner signs' });
  await enforceInvoices(pool, c, u.b);
  return c;
}

const authorsOf = async (id: string) => (await pool.query(
  'SELECT content_authors::TEXT[] AS a, content_edited_at FROM customer_invoices WHERE id = $1', [id])).rows[0] as
  { a: string[]; content_edited_at: Date | null };
const approvalOf = (res: { state: { body: unknown } }) => dataOf<{ approval: { state: string; requestId: string | null } | null }>(res).approval;

describe('the detail GET', () => {
  it('carries the derived approval state while a draft, and null once posted', async () => {
    const c = await gatedCompany();
    const inv = await plantInvoice(pool, c, u.a);
    expect(approvalOf(await r.get(u.a, c, inv.id))).toMatchObject({ state: 'required', requiredRole: 'owner', ruleName: 'Owner signs' });
    const requestId = await r.approvedBy(pool, u.a, u.b, c, inv.id);
    expect(approvalOf(await r.get(u.a, c, inv.id))).toMatchObject({ state: 'approved', requestId });
    expect((await r.approve(u.a, c, inv.id)).state.statusCode).toBe(200);
    expect(approvalOf(await r.get(u.a, c, inv.id))).toBeNull();
  });

  it('says not_required when enforcement is off', async () => {
    const c = await invoiceCompany(pool, [[u.a, 'admin']], companies);
    const inv = await plantInvoice(pool, c, u.a);
    expect(approvalOf(await r.get(u.a, c, inv.id))).toMatchObject({ state: 'not_required', enforced: false });
  });
});

describe('the draft edit (detail PUT)', () => {
  it('moving content makes the approval STALE and the editor an author; reverting clears it (Q9)', async () => {
    const c = await gatedCompany();
    const inv = await plantInvoice(pool, c, u.a);
    await r.approvedBy(pool, u.a, u.b, c, inv.id);
    expect((await r.edit(u.m, c, { id: inv.id, invoiceDate: '2026-09-15' })).state.statusCode).toBe(200);
    const stale = await r.approve(u.a, c, inv.id);
    expect(stale.state.statusCode).toBe(409);
    expect(reasonOf(stale)).toBe('APPROVAL_STALE');
    const after = await authorsOf(inv.id);
    expect(after.a).toEqual([u.m]);
    expect(after.content_edited_at).not.toBeNull();

    expect((await r.edit(u.m, c, { id: inv.id, invoiceDate: '2026-09-01' })).state.statusCode).toBe(200);
    expect((await r.approve(u.a, c, inv.id)).state.statusCode).toBe(200);
  });

  it('an editor-author is refused as the approver of a fresh request', async () => {
    const c = await gatedCompany();
    const inv = await plantInvoice(pool, c, u.a);
    expect((await r.edit(u.c, c, { id: inv.id, invoiceDate: '2026-09-20' })).state.statusCode).toBe(200);
    const raised = await r.raise(u.a, c, inv.id);
    const decided = await r.decide(pool, u.c, c, dataOf<{ id: string }>(raised).id);
    expect(decided.state.statusCode).toBe(403);
    expect(messageOf(decided)).toMatch(/you authored the content/);
  });

  it('an edit the digest does not cover (notes, due date) stamps nobody and keeps the approval', async () => {
    const c = await gatedCompany();
    const inv = await plantInvoice(pool, c, u.a);
    await r.approvedBy(pool, u.a, u.b, c, inv.id);
    expect((await r.edit(u.m, c, { id: inv.id, notes: 'thanks', dueDate: '2026-11-30' })).state.statusCode).toBe(200);
    expect((await authorsOf(inv.id)).a).toEqual([]);
    expect((await r.approve(u.a, c, inv.id)).state.statusCode).toBe(200);
  });

  it('re-sending identical lines (delete + re-insert) keeps the approval and stamps nobody', async () => {
    const c = await gatedCompany();
    // The PUT recomputes functional_total from the lines, so plant the figure it will compute.
    const inv = await plantInvoice(pool, c, u.a, { functionalTotal: 1150 });
    await r.approvedBy(pool, u.a, u.b, c, inv.id);
    const base = await digestOf(pool, c, inv.id);
    const items = [{ description: 'Line A', quantity: 2, unitPrice: 300, taxRate: 15 },
      { description: 'Line B', quantity: 1, unitPrice: 400, taxRate: 15 }];
    const res = await r.edit(u.m, c, { id: inv.id, items });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await digestOf(pool, c, inv.id)).toBe(base);
    expect((await authorsOf(inv.id)).a).toEqual([]);
    expect((await r.approve(u.a, c, inv.id)).state.statusCode).toBe(200);
  });
});

describe('the customer merge', () => {
  it("moving the invoice's customer makes the approval STALE and the merging user an author; moving it back clears it", async () => {
    const c = await gatedCompany();
    const inv = await plantInvoice(pool, c, u.a);
    const target = await plantInvoice(pool, c, u.a);
    await r.approvedBy(pool, u.a, u.b, c, inv.id);
    const merged = await r.merge(u.c, c, inv.customerId, target.customerId);
    expect(merged.state.statusCode, JSON.stringify(merged.state.body)).toBe(200);
    const stale = await r.approve(u.a, c, inv.id);
    expect(reasonOf(stale)).toBe('APPROVAL_STALE');
    expect((await authorsOf(inv.id)).a).toEqual([u.c]);

    const raised = await r.raise(u.a, c, inv.id);
    expect((await r.decide(pool, u.c, c, dataOf<{ id: string }>(raised).id)).state.statusCode).toBe(403);

    await pool.query('UPDATE customer_invoices SET customer_id = $2, client_id = $2 WHERE id = $1', [inv.id, inv.customerId]);
    await pool.query("UPDATE approval_requests SET status = 'cancelled' WHERE document_id = $1 AND status = 'pending'", [inv.id]);
    expect((await r.approve(u.a, c, inv.id)).state.statusCode).toBe(200);
  });

  it('an invoice naming the customer only as client_id is stamped too', async () => {
    const c = await gatedCompany();
    const inv = await plantInvoice(pool, c, u.a);
    const target = await plantInvoice(pool, c, u.a);
    const elsewhere = await plantInvoice(pool, c, u.a);
    await pool.query('UPDATE customer_invoices SET customer_id = $2 WHERE id = $1', [inv.id, elsewhere.customerId]);
    expect((await r.merge(u.c, c, inv.customerId, target.customerId)).state.statusCode).toBe(200);
    expect((await authorsOf(inv.id)).a).toEqual([u.c]);
    expect((await authorsOf(elsewhere.id)).a).toEqual([]);
  });
});

describe('the legacy Post to GL stays ungated (Q7)', () => {
  const postGl = (c: string, invoiceId: string) => callRoute(customerInvoicesGl, tokens[u.a]!, c, 'POST', { invoiceId },
    '/api/accounting/customer-invoices-gl');

  it('still refuses a draft (R-118), and posts an approved invoice that has no journal yet', async () => {
    const c = await gatedCompany();
    const draft = await plantInvoice(pool, c, u.a);
    const refused = await postGl(c, draft.id);
    expect(refused.state.statusCode).toBe(400);
    expect(messageOf(refused)).toMatch(/Cannot post a draft invoice to GL/);
    expect((await invoiceState(pool, draft.id)).journals).toBe(0);

    // Approved before enforcement was switched on, never posted: the legacy case Q7 leaves ungated.
    await pool.query('DELETE FROM approval_enforcement WHERE company_id = $1', [c]);
    const legacy = await plantInvoice(pool, c, u.a, { status: 'approved' });
    await enforceInvoices(pool, c, u.b);
    const posted = await postGl(c, legacy.id);
    expect(posted.state.statusCode, JSON.stringify(posted.state.body)).toBe(200);
    expect((await invoiceState(pool, legacy.id)).journals).toBe(1);
  });
});

describe('the Enforce switch preview', () => {
  it('counts the draft and pending invoices a rule holds, and not the cleared, posted or unmatched ones', async () => {
    const c = await gatedCompany();
    await pool.query('UPDATE approval_rules SET condition_operator = $2, condition_value = 1000 WHERE company_id = $1',
      [c, 'greater_than']);
    await plantInvoice(pool, c, u.a);
    const pending = await plantInvoice(pool, c, u.a);
    await pool.query("UPDATE customer_invoices SET status = 'pending_approval' WHERE id = $1", [pending.id]);
    const cleared = await plantInvoice(pool, c, u.a);
    await r.approvedBy(pool, u.a, u.b, c, cleared.id);
    await plantInvoice(pool, c, u.a, { subtotal: 500, tax: 75, total: 575 });
    const deleted = await plantInvoice(pool, c, u.a);
    await pool.query('UPDATE customer_invoices SET deleted_at = now() WHERE id = $1', [deleted.id]);
    const res = await callRoute(approvalEnforcement, tokens[u.b]!, c, 'GET', undefined,
      '/api/accounting/approval-enforcement', { preview: '1' });
    expect(res.state.statusCode).toBe(200);
    const data = dataOf<{ enforceable: string[]; preview: Record<string, number> }>(res);
    expect(data.enforceable).toContain('customer_invoice');
    expect(data.preview.customer_invoice).toBe(2);
  });
});
