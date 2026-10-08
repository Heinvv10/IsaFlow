/**
 * R-035 PR2: what the UI reads.
 *
 *  - The supplier-invoice detail GET carries `approval` — the DERIVED state
 *    (decision Q3): not_required / required / pending / approved / stale, with
 *    the role today's rule demands and the request to act on.
 *  - The enforcement GET previews, per enforceable type, how many unposted
 *    bills would need approval now (the "would block N bills" hint).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantBill, plantRule } from './r035-approval.helpers';
import { cleanupPr2, dataOf, enforce, postableCompany, routes } from './r035-pr2.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = routes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr2(pool, companies, Object.values(u)));

const company = () => postableCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);

interface Approval { state: string; enforced: boolean; requiredRole: string | null; ruleName: string | null; requestId: string | null }
const approvalOf = async (c: string, id: string) => {
  const res = await r.getBill(u.a, c, id);
  expect(res.state.statusCode).toBe(200);
  return dataOf<{ approval: Approval }>(res).approval;
};

describe('the detail GET carries the derived approval state', () => {
  it('not_required while enforcement is off, even with a rule', async () => {
    const c = await company();
    await plantRule(pool, c, 'owner', { name: 'Owner signs' });
    const bill = await plantBill(pool, c, u.a);
    expect(await approvalOf(c, bill.id)).toMatchObject({ state: 'not_required', enforced: false });
  });

  it('required → pending → approved → stale, naming the role, the rule and the request', async () => {
    const c = await company();
    await plantRule(pool, c, 'owner', { name: 'Owner signs' });
    await enforce(pool, c, u.b);
    const bill = await plantBill(pool, c, u.a);
    expect(await approvalOf(c, bill.id)).toEqual({
      state: 'required', enforced: true, requiredRole: 'owner', ruleName: 'Owner signs', requestId: null,
    });

    const requestId = dataOf<{ id: string }>(await r.raise(u.a, c, bill.id)).id;
    expect(await approvalOf(c, bill.id)).toMatchObject({ state: 'pending', requestId });

    expect((await r.decide(pool, u.b, c, requestId)).state.statusCode).toBe(200);
    expect(await approvalOf(c, bill.id)).toMatchObject({ state: 'approved', requestId });

    expect((await r.editBill(u.a, c, { id: bill.id, invoiceDate: '2026-09-09' })).state.statusCode).toBe(200);
    expect(await approvalOf(c, bill.id)).toMatchObject({ state: 'stale', requestId });
  });
});

describe('the enforcement GET previews what switching on would hold', () => {
  it('counts the unposted bills a rule matches, and none posted, cancelled or below the threshold', async () => {
    const c = await company();
    await plantRule(pool, c, 'owner', { operator: 'greater_than', value: 1000 });
    await plantBill(pool, c, u.a);
    await plantBill(pool, c, u.a);
    const posted = await plantBill(pool, c, u.a);
    await pool.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [posted.id]);
    const cancelled = await plantBill(pool, c, u.a);
    await pool.query("UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1", [cancelled.id]);
    await plantBill(pool, c, u.a, { total: 900 });

    const res = await callRoute(approvalEnforcement, tokens[u.b]!, c, 'GET', undefined, '/api/accounting/approval-enforcement', { preview: '1' });
    expect(res.state.statusCode).toBe(200);
    expect(dataOf<{ preview: Record<string, number> }>(res).preview).toEqual({
      supplier_invoice: 2, customer_credit_note: 0, supplier_credit_note: 0, customer_invoice: 0,
      supplier_payment: 0, payment_batch: 0, manual_journal: 0, supplier_bank_details: 0,
    });
  });
});
