/**
 * Start the Paystack checkout for an invoice from the staff "Pay Now" button (R-177).
 *
 * Two calls: pay-now makes sure the invoice has its standing payment link, then the checkout
 * starts from that link through the same public route the customer's own pay page uses, so
 * both get one checkout per click, a bounded gateway call and the live balance.
 */
import { ApiEnvelopeError, apiFetch, assertOk } from '@/lib/apiFetch';

interface Envelope { data?: Record<string, unknown> }
const MESSAGE = 'Could not start the payment - try again';

/** The 2xx body, or an empty envelope when it is empty / not JSON (the caller then reports a plain sentence). */
const emptyEnvelope = (): Envelope => ({});

/** The hosted-checkout URL to open. Throws with the server's message when either call refuses. */
export async function startPayNowCheckout(invoiceId: string): Promise<string> {
  const link = await apiFetch(`/api/accounting/customer-invoices/${invoiceId}/pay-now`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  await assertOk(link, MESSAGE);
  const linkJson = await link.json().catch(emptyEnvelope) as Envelope;
  if (typeof linkJson.data?.token !== 'string') throw new ApiEnvelopeError(MESSAGE);

  const checkout = await fetch('/api/portal/payments/paystack/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: linkJson.data.token }),
  });
  await assertOk(checkout, MESSAGE);
  const checkoutJson = await checkout.json().catch(emptyEnvelope) as Envelope;
  if (typeof checkoutJson.data?.checkoutUrl !== 'string') throw new ApiEnvelopeError(MESSAGE);
  return checkoutJson.data.checkoutUrl;
}
