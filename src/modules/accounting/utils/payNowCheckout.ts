/**
 * Start the Paystack checkout for an invoice from the staff "Pay Now" button (R-177).
 *
 * Two calls: pay-now makes sure the invoice has its standing payment link, then the checkout
 * starts from that link through the same public route the customer's own pay page uses, so
 * both get one checkout per click, a bounded gateway call and the live balance.
 */
import { apiFetch } from '@/lib/apiFetch';

interface Envelope { data?: Record<string, unknown>; error?: { message?: string }; message?: string }
const failure = (json: Envelope) => new Error(json.error?.message || json.message || 'Failed to start payment');

/** The hosted-checkout URL to open. Throws with the server's message when either call refuses. */
export async function startPayNowCheckout(invoiceId: string): Promise<string> {
  const link = await apiFetch(`/api/accounting/customer-invoices/${invoiceId}/pay-now`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const linkJson = (await link.json()) as Envelope;
  if (!link.ok || typeof linkJson.data?.token !== 'string') throw failure(linkJson);

  const checkout = await fetch('/api/portal/payments/paystack/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: linkJson.data.token }),
  });
  const checkoutJson = (await checkout.json()) as Envelope;
  if (!checkout.ok || typeof checkoutJson.data?.checkoutUrl !== 'string') throw failure(checkoutJson);
  return checkoutJson.data.checkoutUrl;
}
