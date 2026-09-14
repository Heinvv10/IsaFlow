/**
 * R-095 — the customer portal statement and invoice list are broken.
 *
 * portalService.getClientInvoices selected `total` (the column is
 * `total_amount`) and filtered with a bare `status NOT IN ('draft',
 * 'cancelled')`, which R-082 already showed silently drops a NULL-status
 * invoice and admits a pending_approval one. portalService.getClientStatement
 * selected `total AS debit` (same wrong column) and filtered payments on
 * `status = 'posted'`, a value the column's own CHECK constraint forbids
 * (draft/confirmed/reconciled/cancelled) — so /api/portal/statement 500s on
 * every call, as noted (and left out of scope) by r082-statements-exclude-drafts.
 *
 * The fix routes the portal statement through the SAME service the emailed
 * in-app statement already uses (statementEmailService.fetchStatementData),
 * so the portal cannot drift from the in-app figures the way a second
 * hand-written query would. This file:
 *   1. Reproduces both defects directly against the fixture (premise).
 *   2. Confirms the portal statement's totals equal fetchStatementData's
 *      totals for the same customer/date (same population rules: draft,
 *      pending_approval and unconfirmed payments excluded; NULL status kept).
 *   3. Confirms the portal invoice list applies the same population rule.
 *   4. Cross-tenant probe: a token minted for company A's customer must
 *      never surface company B's rows, even when both use the identical
 *      clientId collision-free UUID space (separate companies, same shape).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { signArPortalToken } from '@/lib/auth/arPortalJwt';
import { request, response } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const USER = randomUUID();
const TAG = `R95${Math.floor(Math.random() * 1e8)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());

let customerA = '';
let customerB = '';

describeIfDb('R-095 portal statement matches the in-app statement', () => {
  beforeAll(async () => {
    process.env.PORTAL_JWT_SECRET ??= 'r095-test-portal-secret-over-forty-characters-long';

    for (const company of [COMPANY_A, COMPANY_B]) {
      await sql`INSERT INTO companies (id, name, registration_number) VALUES (${company}::UUID, ${'R095 ' + TAG + company.slice(0, 4)}, ${TAG + company.slice(0, 4)})`;
    }
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${COMPANY_A}::UUID, ${USER}, 'admin')`;

    customerA = ((await sql`
      INSERT INTO customers (company_id, name, email) VALUES (${COMPANY_A}::UUID, ${'cust-a ' + TAG}, ${'a-' + TAG + '@test.local'})
      RETURNING id`) as { id: string }[])[0]!.id;
    customerB = ((await sql`
      INSERT INTO customers (company_id, name, email) VALUES (${COMPANY_B}::UUID, ${'cust-b ' + TAG}, ${'b-' + TAG + '@test.local'})
      RETURNING id`) as { id: string }[])[0]!.id;

    // Invoices for customer A: approved (must appear), draft (must not),
    // NULL status (must still appear per the shared population rule),
    // pending_approval (must not).
    for (const [suffix, status, amount] of [
      ['A', 'approved', 1000], ['D', 'draft', 500], ['N', null, 200], ['P', 'pending_approval', 300],
    ] as const) {
      await sql`
        INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
          status, subtotal, tax_amount, total_amount, amount_paid, created_by)
        VALUES (${COMPANY_A}::UUID, ${customerA}::UUID, ${customerA}::UUID, ${TAG + '-' + suffix}, ${shift(-30)}::date, ${shift(-15)}::date,
          ${status}, ${amount}, 0, ${amount}, 0, ${USER}::UUID)`;
    }
    // A confirmed payment (settles) and a draft one (must not settle).
    await sql`
      INSERT INTO customer_payments (company_id, client_id, payment_number, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY_A}::UUID, ${customerA}::UUID, ${TAG + '-PAY-CONF'}, ${shift(-10)}::date, 400, 'confirmed', ${USER}::UUID)`;
    await sql`
      INSERT INTO customer_payments (company_id, client_id, payment_number, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY_A}::UUID, ${customerA}::UUID, ${TAG + '-PAY-DRAFT'}, ${shift(-10)}::date, 999, 'draft', ${USER}::UUID)`;

    // Customer B: one invoice, wholly separate company — must never leak
    // into A's portal statement/invoices.
    await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY_B}::UUID, ${customerB}::UUID, ${customerB}::UUID, ${TAG + '-B'}, ${shift(-30)}::date, ${shift(-15)}::date,
        'approved', 5000, 0, 5000, 0, ${USER}::UUID)`;
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM customer_payments WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
    await sql`DELETE FROM customer_invoices WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
    await sql`DELETE FROM customers WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('premise: the old query shape 500s — total column does not exist on customer_invoices', async () => {
    await expect(sql`SELECT total FROM customer_invoices WHERE id = ${customerA}::UUID`).rejects.toThrow();
  });

  it("premise: 'posted' is not a legal customer_payments status", async () => {
    await expect(sql`
      INSERT INTO customer_payments (company_id, client_id, payment_number, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY_A}::UUID, ${customerA}::UUID, ${TAG + '-BAD'}, ${TODAY}::date, 1, 'posted', ${USER}::UUID)
    `).rejects.toThrow();
  });

  it('portal statement route: figures equal fetchStatementData for the same customer/date', async () => {
    const { fetchStatementData } = await import('@/modules/accounting/services/ar/statementEmailService');
    const expected = await fetchStatementData(COMPANY_A, customerA, TODAY);
    expect(expected).not.toBeNull();

    const token = await signArPortalToken({ clientId: customerA, companyId: COMPANY_A, email: 'a@test.local' });
    const { default: route } = await import('../../pages/api/portal/statement');
    const req = request({ portal_session: token }, 'GET');
    (req as unknown as { query: unknown }).query = { clientId: customerA, asOf: TODAY };
    const result = response();
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);

    expect(result.state.statusCode).toBe(200);
    const body = (result.state.body as { data: {
      transactions: { reference: string; debit: number; credit: number }[];
      closingBalance: number;
    } }).data;

    const refs = body.transactions.filter(t => t.reference.startsWith(TAG)).map(t => t.reference).sort();
    expect(refs).toEqual([TAG + '-A', TAG + '-N', TAG + '-PAY-CONF'].sort());
    expect(refs).not.toContain(TAG + '-D');
    expect(refs).not.toContain(TAG + '-P');
    expect(refs).not.toContain(TAG + '-PAY-DRAFT');
    expect(body.closingBalance).toBe(expected!.summary.balance);
    expect(body.closingBalance).toBe(800); // 1000 (A) + 200 (N) - 400 (confirmed payment)
  });

  it('portal invoices route: same population rule as the in-app statement (draft/pending_approval excluded, NULL kept)', async () => {
    const token = await signArPortalToken({ clientId: customerA, companyId: COMPANY_A, email: 'a@test.local' });
    const { default: route } = await import('../../pages/api/portal/invoices');
    const req = request({ portal_session: token }, 'GET');
    (req as unknown as { query: unknown }).query = { clientId: customerA };
    const result = response();
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);

    expect(result.state.statusCode).toBe(200);
    const body = (result.state.body as { data: { items: { invoiceNumber: string; total: number }[] } }).data;
    const refs = body.items.filter(i => i.invoiceNumber.startsWith(TAG)).map(i => i.invoiceNumber).sort();
    expect(refs).toEqual([TAG + '-A', TAG + '-N'].sort());
    const rowA = body.items.find(i => i.invoiceNumber === TAG + '-A');
    expect(rowA?.total).toBe(1000);
  });

  it('cross-tenant: a token for company A cannot see company B rows via clientId substitution', async () => {
    const tokenForA = await signArPortalToken({ clientId: customerA, companyId: COMPANY_A, email: 'a@test.local' });
    const { default: route } = await import('../../pages/api/portal/statement');
    const req = request({ portal_session: tokenForA }, 'GET');
    // Attempt to read customer B's statement using A's session cookie.
    (req as unknown as { query: unknown }).query = { clientId: customerB, asOf: TODAY };
    const result = response();
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
    expect(result.state.statusCode).toBe(403);
  });

  it('cross-tenant: a forged token naming B\'s customer but A\'s companyId sees nothing (fetchStatementData scopes by company_id)', async () => {
    const forged = await signArPortalToken({ clientId: customerB, companyId: COMPANY_A, email: 'x@test.local' });
    const { default: route } = await import('../../pages/api/portal/statement');
    const req = request({ portal_session: forged }, 'GET');
    (req as unknown as { query: unknown }).query = { clientId: customerB, asOf: TODAY };
    const result = response();
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
    // customerB does not belong to COMPANY_A, so the company-scoped customer
    // lookup inside fetchStatementData finds nothing.
    expect(result.state.statusCode).toBe(404);
  });
});
