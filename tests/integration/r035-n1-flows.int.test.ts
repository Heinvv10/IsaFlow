/**
 * R-035 N1: with approval_requests writable only through the definer
 * functions, the app's whole flow still works for EVERY enforceable type —
 * A (admin, the author) raises through the route, B (owner) approves through
 * the route, A posts through the document's own route — and the request rows
 * the functions wrote are what the gates clear on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantBill, plantRule } from './r035-approval.helpers';
import { billState, dataOf, enforce, postableCompany, routes } from './r035-pr2.helpers';
import { approvalTypeOf, enforceType, noteCompany, noteRoutes, noteState, plantNote } from './r035-pr3.helpers';
import { enforceInvoices, invoiceCompany, invoiceRoutes, invoiceState, plantInvoice } from './r035-pr4.helpers';
import { batchState, enforcePay, payCompany, paymentState, payRoutes, plantBatch, plantPayment } from './r035-pr5.helpers';
import { cleanupPr6, enforceJournals, journalCompany, journalRoutes, journalRule, journalState, plantJournal } from './r035-pr6.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const members = (): [string, string][] => [[u.a, 'admin'], [u.b, 'owner']];

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr6(pool, companies, Object.values(u)));

/** The request the route raised: pending → approved by B, bound to the owner rule. */
async function expectApprovedBy(requestId: string, ruleId: string) {
  const { rows: [row] } = await pool.query('SELECT status, decided_by, rule_id, required_role FROM approval_requests WHERE id = $1',
    [requestId]);
  expect(row).toEqual({ status: 'approved', decided_by: u.b, rule_id: ruleId, required_role: 'owner' });
}

const ok = (res: { state: { statusCode: number; body: unknown } }) =>
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);

describe('raise → approve → post, through the routes, for every type', () => {
  it('supplier_invoice', async () => {
    const c = await postableCompany(pool, members(), companies);
    const rule = await plantRule(pool, c, 'owner');
    await enforce(pool, c, u.b);
    const bill = await plantBill(pool, c, u.a);
    const r = routes(tokens);
    const raised = await r.raise(u.a, c, bill.id);
    ok(raised);
    const requestId = dataOf<{ id: string }>(raised).id;
    ok(await r.decide(pool, u.b, c, requestId));
    await expectApprovedBy(requestId, rule);
    ok(await r.approveBill(u.a, c, bill.id));
    expect((await billState(pool, bill.id)).status).toBe('approved');
  });

  it('customer_invoice', async () => {
    const c = await invoiceCompany(pool, members(), companies);
    const rule = await plantRule(pool, c, 'owner', { documentType: 'customer_invoice' });
    await enforceInvoices(pool, c, u.b);
    const inv = await plantInvoice(pool, c, u.a);
    const r = invoiceRoutes(tokens);
    await expectApprovedBy(await r.approvedBy(pool, u.a, u.b, c, inv.id), rule);
    ok(await r.approve(u.a, c, inv.id));
    expect((await invoiceState(pool, inv.id)).gl_journal_entry_id).not.toBeNull();
  });

  it.each(['customer', 'supplier'] as const)('%s_credit_note', async (type) => {
    const c = await noteCompany(pool, members(), companies);
    const rule = await plantRule(pool, c, 'owner', { documentType: approvalTypeOf(type) });
    await enforceType(pool, c, type, u.b);
    const note = await plantNote(pool, c, u.a, type);
    const r = noteRoutes(tokens);
    const raised = await r.raise(u.a, c, approvalTypeOf(type), note.id);
    ok(raised);
    const requestId = dataOf<{ id: string }>(raised).id;
    ok(await r.decide(pool, u.b, c, requestId));
    await expectApprovedBy(requestId, rule);
    ok(await r.approve(u.a, c, note.id));
    expect((await noteState(pool, note.id)).gl_journal_entry_id).not.toBeNull();
  });

  it('supplier_payment', async () => {
    const { company: c, bank } = await payCompany(pool, members(), companies);
    const rule = await plantRule(pool, c, 'owner', { documentType: 'supplier_payment' });
    await enforcePay(pool, c, 'supplier_payment', u.b);
    const p = await plantPayment(pool, c, u.a, bank);
    const r = payRoutes(tokens);
    await expectApprovedBy(await r.approvedBy(pool, u.a, u.b, c, 'supplier_payment', p.id), rule);
    ok(await r.payment(u.a, c, 'approve', p.id));
    ok(await r.payment(u.a, c, 'process', p.id));
    expect((await paymentState(pool, p.id)).status).toBe('processed');
  });

  it('payment_batch', async () => {
    const { company: c, bank } = await payCompany(pool, members(), companies);
    const rule = await plantRule(pool, c, 'owner', { documentType: 'payment_batch' });
    await enforcePay(pool, c, 'payment_batch', u.b);
    const b = await plantBatch(pool, c, u.a, bank);
    const r = payRoutes(tokens);
    await expectApprovedBy(await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id), rule);
    ok(await r.batch(u.a, c, 'approve', b.id));
    ok(await r.batch(u.a, c, 'process', b.id));
    expect((await batchState(pool, b.id)).status).not.toBe('draft');
  });

  it('manual_journal', async () => {
    const f = await journalCompany(pool, members(), companies);
    const rule = await journalRule(plantRule, pool, f.c, { role: 'owner' });
    await enforceJournals(pool, f.c, u.b);
    const id = await plantJournal(pool, f, u.a);
    const r = journalRoutes(tokens);
    await expectApprovedBy(await r.approvedBy(pool, u.a, u.b, f.c, id), rule);
    ok(await r.post(u.a, f.c, id));
    expect((await journalState(pool, id)).status).toBe('posted');
  });
});
