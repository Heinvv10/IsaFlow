/**
 * R-095 fixture: one portal customer with every document shape the portal must
 * get right, a sibling customer in the same company, and a customer of another
 * company. Shared by the parity and the session-scoping files.
 *
 * Customer A (company A), as at today:
 *   invoices   INV-1 approved 1000 (400 paid), INV-2 paid 500, INV-N NULL-status 200,
 *              INV-3 sent 1234.56                                    -> 2934.56 in
 *              DRAFT 111, CANCELLED 222, PENDING 333, SOFTDEL 444    -> never shown
 *              XCO 9999: client_id = A but company_id = B (a corrupt row) -> never shown
 *   receipts   RCPT-1 confirmed 400 (allocated to INV-1), RCPT-2 reconciled 500
 *              (allocated to INV-2), RCPT-U confirmed 250 unallocated -> 1150 in
 *              RCPT-DRAFT 999                                         -> never shown
 *   credits    CN-APPROVED 150, CN-APPLIED 200 (applied 200)         -> 350 in
 *              CN-DRAFT 77                                            -> never shown
 *   closing balance 2934.56 - 1150 - 350 = 1434.56
 */
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { signArPortalToken } from '@/lib/auth/arPortalJwt';
import { request, response } from './mfa-impersonation-postgres.helpers';

export const EXPECTED_CLOSING = 1434.56;
const TEST_IP = `10.95.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

export function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

export interface PortalFixture {
  tag: string;
  companyA: string;
  companyB: string;
  user: string;
  customerA: string;
  sibling: string;
  other: string;
  emailA: string;
  emailSibling: string;
  emailOther: string;
  softDeletedInvoiceToken: string;
  issuedInvoiceToken: string;
}

export async function seedPortalFixture(): Promise<PortalFixture> {
  process.env.PORTAL_JWT_SECRET ??= 'r095-test-portal-secret-over-forty-characters-long';
  const tag = `R95${Math.floor(Math.random() * 1e8)}`;
  const companyA = randomUUID();
  const companyB = randomUUID();
  const user = randomUUID();
  for (const co of [companyA, companyB]) {
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${co}::UUID, ${'R095 ' + tag + co.slice(0, 4)}, ${tag + co.slice(0, 4)})`;
  }
  await sql`INSERT INTO users (id, email, role, is_active) VALUES (${user}, ${user + '@test.local'}, 'admin', true)`;
  await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${companyA}::UUID, ${user}, 'admin')`;

  const customer = async (co: string, name: string, email: string) => {
    const id = ((await sql`INSERT INTO customers (company_id, name, email) VALUES (${co}::UUID, ${name + ' ' + tag}, ${email}) RETURNING id`) as { id: string }[])[0]!.id;
    // The hash is never checked by these files (tokens are signed directly);
    // the row is what makes a session live.
    await sql`INSERT INTO portal_access (client_id, company_id, email, password_hash, name) VALUES (${id}::UUID, (SELECT company_id FROM customers WHERE id = ${id}::UUID), ${email}, 'x', ${name})`;
    return id;
  };
  const emailA = `a-${tag}@test.local`;
  const emailSibling = `s-${tag}@test.local`;
  const emailOther = `o-${tag}@test.local`;
  const customerA = await customer(companyA, 'cust-a', emailA);
  const sibling = await customer(companyA, 'sibling', emailSibling);
  const other = await customer(companyB, 'other-co', emailOther);

  const invoice = async (co: string, c: string, suffix: string, status: string | null, total: number, paid: number, days: number, token: string | null = null) =>
    ((await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by, portal_token)
      VALUES (${co}::UUID, ${c}::UUID, ${c}::UUID, ${tag + '-' + suffix}, ${shift(days)}::date, ${shift(days + 30)}::date,
        ${status}, ${total}, 0, ${total}, ${paid}, ${user}::UUID, ${token})
      RETURNING id`) as { id: string }[])[0]!.id;
  const issuedInvoiceToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const softDeletedInvoiceToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const inv1 = await invoice(companyA, customerA, 'INV-1', 'approved', 1000, 400, -60, issuedInvoiceToken);
  const inv2 = await invoice(companyA, customerA, 'INV-2', 'paid', 500, 500, -45);
  await invoice(companyA, customerA, 'INV-N', null, 200, 0, -40);
  await invoice(companyA, customerA, 'INV-3', 'sent', 1234.56, 0, -20);
  await invoice(companyA, customerA, 'DRAFT', 'draft', 111, 0, -10);
  await invoice(companyA, customerA, 'CANCELLED', 'cancelled', 222, 0, -10);
  await invoice(companyA, customerA, 'PENDING', 'pending_approval', 333, 0, -10);
  const softDeleted = await invoice(companyA, customerA, 'SOFTDEL', 'approved', 444, 0, -10, softDeletedInvoiceToken);
  await sql`UPDATE customer_invoices SET deleted_at = NOW() WHERE id = ${softDeleted}::UUID`;
  await invoice(companyB, customerA, 'XCO', 'approved', 9999, 0, -30);
  await invoice(companyA, sibling, 'SIBLING', 'approved', 5000, 0, -30);
  await invoice(companyB, other, 'OTHERCO', 'approved', 7000, 0, -30);

  const receipt = async (suffix: string, total: number, status: string, days: number) =>
    ((await sql`
      INSERT INTO customer_payments (company_id, client_id, payment_number, payment_date, total_amount, status, created_by)
      VALUES (${companyA}::UUID, ${customerA}::UUID, ${tag + '-' + suffix}, ${shift(days)}::date, ${total}, ${status}, ${user}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
  const r1 = await receipt('RCPT-1', 400, 'confirmed', -35);
  const r2 = await receipt('RCPT-2', 500, 'reconciled', -30);
  await receipt('RCPT-U', 250, 'confirmed', -5);
  await receipt('RCPT-DRAFT', 999, 'draft', -5);
  await sql`INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
    VALUES (${r1}::UUID, ${inv1}::UUID, 400), (${r2}::UUID, ${inv2}::UUID, 500)`;

  for (const [suffix, status, total, applied, days] of [
    ['CN-APPROVED', 'approved', 150, 0, -15], ['CN-APPLIED', 'applied', 200, 200, -12], ['CN-DRAFT', 'draft', 77, 0, -12],
  ] as const) {
    await sql`
      INSERT INTO credit_notes (company_id, client_id, type, credit_note_number, credit_date, status, subtotal, total_amount, applied_amount, created_by)
      VALUES (${companyA}::UUID, ${customerA}::UUID, 'customer', ${tag + '-' + suffix}, ${shift(days)}::date, ${status}, ${total}, ${total}, ${applied}, ${user}::UUID)`;
  }
  return { tag, companyA, companyB, user, customerA, sibling, other, emailA, emailSibling, emailOther, softDeletedInvoiceToken, issuedInvoiceToken };
}

export async function cleanupPortalFixture(f: PortalFixture): Promise<void> {
  const cos = [f.companyA, f.companyB];
  await sql`DELETE FROM portal_access WHERE client_id IN (${f.customerA}::UUID, ${f.sibling}::UUID, ${f.other}::UUID)`;
  await sql`DELETE FROM credit_notes WHERE company_id = ANY(${cos}::UUID[])`;
  await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ANY(${cos}::UUID[]))`;
  await sql`DELETE FROM customer_payments WHERE company_id = ANY(${cos}::UUID[])`;
  await sql`DELETE FROM customer_invoices WHERE company_id = ANY(${cos}::UUID[])`;
  await sql`DELETE FROM customers WHERE company_id = ANY(${cos}::UUID[])`;
  await sql`DELETE FROM company_users WHERE user_id = ${f.user}`;
  await sql`DELETE FROM companies WHERE id = ANY(${cos}::UUID[])`;
  await sql`DELETE FROM users WHERE id = ${f.user}`;
}

export function tokenFor(clientId: string, companyId: string, email: string): Promise<string> {
  return signArPortalToken({ clientId, companyId, email });
}

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

/** Calls a portal route with a portal_session cookie; returns status and body. */
export async function callPortal(
  route: 'statement' | 'invoices' | 'chat',
  token: string | null,
  input: { query?: Record<string, unknown>; body?: Record<string, unknown> },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const mod = route === 'statement' ? await import('../../pages/api/portal/statement')
    : route === 'invoices' ? await import('../../pages/api/portal/invoices')
    : await import('../../pages/api/portal/chat');
  const req = request(token ? { portal_session: token } : {}, route === 'chat' ? 'POST' : 'GET');
  // The chat's per-IP limiter is DB-backed (20 per 15 minutes), so a fixed test
  // IP makes a re-run within the window a 429. One address per test process.
  Object.assign(req, { query: input.query ?? {}, body: input.body ?? {} });
  (req.headers as Record<string, string>)['x-forwarded-for'] = TEST_IP;
  const result = response();
  await (mod.default as unknown as Handler)(req, result.res);
  return { status: result.state.statusCode, body: (result.state.body ?? {}) as Record<string, unknown> };
}
