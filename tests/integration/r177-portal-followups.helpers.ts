/**
 * R-177..R-180 callers shared by the two follow-up suites. Each suite mocks
 * `@/modules/billing/services/paystackClient` itself; routes are imported lazily, so they resolve
 * against that mock.
 */
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { request } from './mfa-impersonation-postgres.helpers';
import { CO, CUSTOMER, USER, call, pool } from './r167-portal-links.helpers';
import { als } from '@/lib/als';
import { enableOnlinePayment as enableOnlinePaymentInTx } from '@/modules/accounting/services/core/paymentGatewayPortalService';

let jwt = '';
export async function signIn(): Promise<void> {
  jwt = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

/** An invoice for R115.00 with no link yet. `paid` may be a string for NaN. */
export async function invoice(status = 'sent', paid: number | string = 0): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices (id, company_id, customer_id, client_id, invoice_number, invoice_date,
       subtotal, tax_amount, total_amount, amount_paid, status, created_by)
     VALUES ($1, $2, $3, $3, $4, CURRENT_DATE, 100, 15, 115, $5, $6, $7)`,
    [id, CO, CUSTOMER, `R177-${id.slice(0, 8)}`, paid, status, USER]);
  return id;
}
const authed = (extra: Record<string, unknown>) =>
  ({ ...(request({ 'sb-access-token': jwt, active_company_id: CO }, 'POST') as object), ...extra });
export const payNow = async (invoiceId: string) => call(
  (await import('../../pages/api/accounting/customer-invoices/[id]/pay-now')).default as never, authed({ query: { id: invoiceId } }));
export const mintExplicit = async (invoiceId: string, amount = 10) => call(
  (await import('../../pages/api/portal/payment-link')).default as never,
  authed({ query: {}, body: { invoiceId, clientId: CUSTOMER, amount } }));
/** The service in a transaction of its own, as the fixture's owner: no row security, so only its predicates isolate. */
export async function enableOnlinePayment(companyId: string, invoiceId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const url = await als.run({ client, userId: USER, companyId, claims: {} } as never, () => enableOnlinePaymentInTx(companyId, invoiceId));
    await client.query('COMMIT');
    return url;
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}
export const links = async (invoiceId: string) => (await pool.query<{ token: string; expires_at: Date | null; charges_balance: boolean }>(
  'SELECT token, expires_at, charges_balance FROM portal_payment_links WHERE invoice_id = $1 ORDER BY created_at', [invoiceId])).rows;
export const tokenOf = (r: { body: { data?: Record<string, unknown> } }) => String(r.body.data?.token);
