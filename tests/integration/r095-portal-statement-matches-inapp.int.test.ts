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
 * statement already uses (statementEmailService.fetchStatementData). That is
 * ALSO what the MCP `customer_statement` tool reads from, so the portal now
 * agrees with the email and the MCP tool exactly.
 *
 * Round 1 review (review-r095-r1.md) found this file's title and fix.md
 * overclaimed: the portal does NOT match the in-app SCREEN
 * (pages/api/accounting/customer-statement.ts), which is a genuinely
 * different report — it credits a receipt at its allocated figure (not the
 * full receipt), counts only 'approved' credit notes (an 'applied' one
 * disappears), and runs a one-year default window with no opening balance.
 * fetchStatementData credits the full receipt, counts approved AND applied
 * notes at their applied amount, and runs from inception. Reconciling the
 * screen to the email/MCP/portal rule is a separate decision (Hein's call —
 * R-083 is already changing the credit-note side of it) and gets its own
 * register entry; this file and fix.md now say only what round 1 could
 * verify: portal == email == MCP, screen is a known, tracked difference.
 *
 * This file:
 *   1. Reproduces the original defects directly against the fixture (premise).
 *   2. Confirms the portal statement's totals equal fetchStatementData's
 *      totals for the same customer/date (same population rules: draft,
 *      pending_approval and unconfirmed payments excluded; NULL status kept;
 *      a live credit note counted — round 2 L5/M5: the suite passed with no
 *      credit-note fixture at all, so a filtered-out credit note could not
 *      have failed anything).
 *   3. Confirms the portal invoice list applies the same population rule,
 *      and (round 2 L5/M4) that the invoice list's OWN company_id predicate
 *      is load-bearing independently of the customer-existence check added
 *      for L4 — a corrupted invoice row (client_id pointing at a customer of
 *      a DIFFERENT company than the invoice's own company_id) must not
 *      surface through either barrier.
 *   4. Cross-tenant probes on the statement and invoices routes: a token
 *      minted for company A's customer must never surface company B's rows.
 *   5. Round 2 M2: /api/portal/chat, which shares the portal_session cookie
 *      and reads customer data but was missed by round 1's census — it
 *      selected `amount`/`customer_id` (neither exists on customer_payments)
 *      and quoted a balance via the same unrouted bare status predicate.
 *   6. Round 2 L3: `asOf` validation (garbage / repeated param → 400) and its
 *      default (asAtTodayStr(), not a UTC-rolling toISOString() slice).
 *   7. Round 2 L4: a soft-deleted customer cannot log in, and a session
 *      minted before the delete cannot still list invoices.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { signArPortalToken } from '@/lib/auth/arPortalJwt';
import { createPortalUser, authenticatePortalUser } from '@/modules/accounting/services/ar/portalService';
import { asAtTodayStr } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
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
let customerD = ''; // soft-delete probe (L4)

describeIfDb('R-095 portal statement matches the emailed/MCP statement (screen parity tracked separately)', () => {
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
    customerD = ((await sql`
      INSERT INTO customers (company_id, name, email) VALUES (${COMPANY_A}::UUID, ${'cust-d ' + TAG}, ${'d-' + TAG + '@test.local'})
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

    // L5/M5: a live (approved) credit note. Round 1 found the suite stayed
    // green with credit_note rows filtered out of the portal's transactions
    // entirely, because no fixture ever had one.
    await sql`
      INSERT INTO credit_notes (company_id, client_id, type, credit_note_number, credit_date, status, subtotal, total_amount, created_by)
      VALUES (${COMPANY_A}::UUID, ${customerA}::UUID, 'customer', ${TAG + '-CN'}, ${shift(-5)}::date, 'approved', 150, 150, ${USER}::UUID)`;

    // L5/M4: a corrupted invoice row — client_id points at customer A, but
    // company_id is company B's. Nothing in the schema stops this (client_id
    // and company_id are independent FKs). This exercises the invoice list's
    // OWN `ci.company_id = companyId` predicate specifically, independent of
    // the L4 customer-existence pre-check (which passes here — customer A
    // genuinely belongs to company A).
    await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY_B}::UUID, ${customerA}::UUID, ${customerA}::UUID, ${TAG + '-XCO'}, ${shift(-30)}::date, ${shift(-15)}::date,
        'approved', 9999, 0, 9999, 0, ${USER}::UUID)`;

    // Customer B: one invoice, wholly separate company — must never leak
    // into A's portal statement/invoices.
    await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY_B}::UUID, ${customerB}::UUID, ${customerB}::UUID, ${TAG + '-B'}, ${shift(-30)}::date, ${shift(-15)}::date,
        'approved', 5000, 0, 5000, 0, ${USER}::UUID)`;

    // Customer D: one invoice, for the L4 soft-delete probe.
    await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY_A}::UUID, ${customerD}::UUID, ${customerD}::UUID, ${TAG + '-DEL'}, ${shift(-30)}::date, ${shift(-15)}::date,
        'approved', 700, 0, 700, 0, ${USER}::UUID)`;
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM portal_access WHERE client_id = ${customerD}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
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

  it('portal statement route: figures equal fetchStatementData for the same customer/date, including a live credit note', async () => {
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
      transactions: { reference: string; debit: number; credit: number; description: string }[];
      closingBalance: number;
    } }).data;

    const refs = body.transactions.filter(t => t.reference.startsWith(TAG)).map(t => t.reference).sort();
    expect(refs).toEqual([TAG + '-A', TAG + '-N', TAG + '-PAY-CONF', TAG + '-CN'].sort());
    expect(refs).not.toContain(TAG + '-D');
    expect(refs).not.toContain(TAG + '-P');
    expect(refs).not.toContain(TAG + '-PAY-DRAFT');

    const cnRow = body.transactions.find(t => t.reference === TAG + '-CN');
    expect(cnRow).toMatchObject({ credit: 150, description: 'Credit Note' });

    expect(body.closingBalance).toBe(expected!.summary.balance);
    expect(body.closingBalance).toBe(650); // 1000 (A) + 200 (N) - 400 (payment) - 150 (credit note)
  });

  it('portal invoices route: same population rule as the in-app statement, and its own company_id predicate excludes a cross-company row', async () => {
    const token = await signArPortalToken({ clientId: customerA, companyId: COMPANY_A, email: 'a@test.local' });
    const { default: route } = await import('../../pages/api/portal/invoices');
    const req = request({ portal_session: token }, 'GET');
    (req as unknown as { query: unknown }).query = { clientId: customerA };
    const result = response();
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);

    expect(result.state.statusCode).toBe(200);
    const body = (result.state.body as { data: { items: { invoiceNumber: string; total: number }[] } }).data;
    const refs = body.items.filter(i => i.invoiceNumber.startsWith(TAG)).map(i => i.invoiceNumber).sort();
    // -XCO is excluded here: it belongs to customer A (client_id matches) but
    // was recorded against company B. The invoice list's own
    // `ci.company_id = companyId` predicate is what keeps it out.
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

  it('cross-tenant: a forged token naming B\'s customer but A\'s companyId sees nothing on statement or invoices', async () => {
    const forged = await signArPortalToken({ clientId: customerB, companyId: COMPANY_A, email: 'x@test.local' });

    const { default: statementRoute } = await import('../../pages/api/portal/statement');
    const req1 = request({ portal_session: forged }, 'GET');
    (req1 as unknown as { query: unknown }).query = { clientId: customerB, asOf: TODAY };
    const result1 = response();
    await (statementRoute as unknown as (a: unknown, b: unknown) => Promise<void>)(req1, result1.res);
    // customerB does not belong to COMPANY_A, so the company-scoped customer
    // lookup inside fetchStatementData finds nothing.
    expect(result1.state.statusCode).toBe(404);

    const { default: invoicesRoute } = await import('../../pages/api/portal/invoices');
    const req2 = request({ portal_session: forged }, 'GET');
    (req2 as unknown as { query: unknown }).query = { clientId: customerB };
    const result2 = response();
    await (invoicesRoute as unknown as (a: unknown, b: unknown) => Promise<void>)(req2, result2.res);
    // Same customer-existence pre-check (L4) now guards getClientInvoices too.
    expect(result2.state.statusCode).toBe(404);
  });

  it('M2: /api/portal/chat no longer 500s, and quotes the SAME balance as the statement route', async () => {
    const { fetchStatementData } = await import('@/modules/accounting/services/ar/statementEmailService');
    const expected = await fetchStatementData(COMPANY_A, customerA, asAtTodayStr());

    const token = await signArPortalToken({ clientId: customerA, companyId: COMPANY_A, email: 'a@test.local' });
    const { default: route } = await import('../../pages/api/portal/chat');
    const req = request({ portal_session: token }, 'POST');
    (req as unknown as { body: unknown }).body = { question: 'what do I owe?', clientId: customerA };
    const result = response();
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);

    expect(result.state.statusCode).toBe(200);
    const body = (result.state.body as { data: { clientContext: { balance: number; openInvoices: number } } }).data;
    expect(body.clientContext.balance).toBe(expected!.summary.balance);
    // A and N are open (D, P excluded); XCO belongs to a different company_id.
    expect(body.clientContext.openInvoices).toBe(2);
  });

  it('L3: asOf rejects garbage and a repeated (array) param with 400, not 500', async () => {
    const token = await signArPortalToken({ clientId: customerA, companyId: COMPANY_A, email: 'a@test.local' });
    const { default: route } = await import('../../pages/api/portal/statement');

    const req1 = request({ portal_session: token }, 'GET');
    (req1 as unknown as { query: unknown }).query = { clientId: customerA, asOf: 'garbage' };
    const result1 = response();
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req1, result1.res);
    expect(result1.state.statusCode).toBe(400);

    const req2 = request({ portal_session: token }, 'GET');
    (req2 as unknown as { query: unknown }).query = { clientId: customerA, asOf: [TODAY, TODAY] };
    const result2 = response();
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req2, result2.res);
    expect(result2.state.statusCode).toBe(400);
  });

  it('L3: asOf defaults to asAtTodayStr(), not a UTC-rolling toISOString() slice', async () => {
    const token = await signArPortalToken({ clientId: customerA, companyId: COMPANY_A, email: 'a@test.local' });
    const { default: route } = await import('../../pages/api/portal/statement');
    const req = request({ portal_session: token }, 'GET');
    (req as unknown as { query: unknown }).query = { clientId: customerA };
    const result = response();
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
    expect(result.state.statusCode).toBe(200);
    const body = (result.state.body as { data: { asOfDate: string } }).data;
    expect(body.asOfDate).toBe(asAtTodayStr());
  });

  it('L4: a soft-deleted customer cannot log in, and an existing session cannot still list invoices', async () => {
    await createPortalUser({ clientId: customerD, email: `portal-${TAG}@test.local`, password: 'r095-portal-test-password-2026', name: 'D Portal' });

    // Before delete: login works.
    const before = await authenticatePortalUser(`portal-${TAG}@test.local`, 'r095-portal-test-password-2026');
    expect(before).not.toBeNull();

    await sql`UPDATE customers SET deleted_at = NOW() WHERE id = ${customerD}::UUID`;

    // After delete: login must refuse, even with the correct password.
    const after = await authenticatePortalUser(`portal-${TAG}@test.local`, 'r095-portal-test-password-2026');
    expect(after).toBeNull();

    // A session token minted BEFORE the delete (24h JWT expiry means one can
    // still be live) must not still be able to list invoices.
    const staleToken = await signArPortalToken({ clientId: customerD, companyId: COMPANY_A, email: `portal-${TAG}@test.local` });
    const { default: route } = await import('../../pages/api/portal/invoices');
    const req = request({ portal_session: staleToken }, 'GET');
    (req as unknown as { query: unknown }).query = { clientId: customerD };
    const result = response();
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
    expect(result.state.statusCode).toBe(404);

    await sql`UPDATE customers SET deleted_at = NULL WHERE id = ${customerD}::UUID`;
  });
});
