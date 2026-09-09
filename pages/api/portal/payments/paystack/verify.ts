/**
 * GET /api/portal/payments/paystack/verify?ref=<reference>
 * Public — called by /portal/payments/paystack/return to resolve final status.
 * Looks up by paystack_reference and, if still pending, re-queries Paystack
 * for the live state. The webhook is the canonical source of truth; this
 * endpoint is a UX-side fallback so the return page does not have to wait
 * for the webhook to arrive.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { verifyTransaction } from '@/modules/billing/services/paystackClient';
import { withPublicRouteTransaction } from '@/lib/publicRouteTx';
import { recordGatewayInvoiceReceipt } from '@/modules/accounting/services/ar/gatewayInvoiceReceiptService';

interface PrRow {
  id: string;
  company_id: string;
  customer_invoice_id: string | null;
  paystack_reference: string;
  amount_cents: string;
  status: string;
  invoice_number: string | null;
  invoice_total: string | null;
  invoice_amount_paid: string | null;
  company_name: string | null;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }
  const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
  if (!ref) return apiResponse.badRequest(res, 'Missing ref');

  // H7: this endpoint is public and re-queries the Paystack API — rate-limit by IP
  // to stop reference brute-forcing and Paystack-API abuse.
  if (!(await checkRateLimit(`paystack-verify:${getClientIp(req)}`, { max: 30, windowSecs: 900 }))) {
    return apiResponse.tooManyRequests(res, 'Too many verification attempts. Please wait and retry.');
  }

  const rows = await sql<PrRow>`
    SELECT pr.id, pr.company_id, pr.customer_invoice_id, pr.paystack_reference,
           pr.amount_cents, pr.status,
           ci.invoice_number, ci.total_amount::text AS invoice_total,
           ci.amount_paid::text AS invoice_amount_paid,
           co.name AS company_name
    FROM paystack_payment_requests pr
    LEFT JOIN customer_invoices ci ON ci.id = pr.customer_invoice_id
    LEFT JOIN companies co ON co.id = pr.company_id
    WHERE pr.paystack_reference = ${ref}
    LIMIT 1
  `;
  const pr = rows[0];
  if (!pr) return apiResponse.notFound(res, 'Payment');

  let status = pr.status;
  if (status === 'pending') {
    try {
      const live = await verifyTransaction(pr.paystack_reference);
      let mapped: 'completed' | 'failed' | 'cancelled' | 'pending' = 'pending';
      if (live.status === 'success') mapped = 'completed';
      else if (live.status === 'failed') mapped = 'failed';
      else if (live.status === 'abandoned') mapped = 'cancelled';
      const isTerminal = mapped !== 'pending';
      if (mapped !== status && isTerminal) {
        // One transaction: the status change and the ledger posting stand or
        // fall together, so a GL failure cannot leave the request completed
        // (and the invoice paid) with nothing in the books. On a throw the
        // catch below logs and the webhook remains free to apply it later.
        await withPublicRouteTransaction('paystack-verify', async () => {
          await sql`
            UPDATE paystack_payment_requests
            SET status = ${mapped},
                completed_at = CASE WHEN ${mapped} = 'completed' THEN COALESCE(completed_at, now()) ELSE completed_at END,
                paystack_transaction_id = ${live.id ?? null},
                paystack_authorization_code = COALESCE(${live.authorization?.authorizationCode ?? null}, paystack_authorization_code),
                channel = COALESCE(${live.channel ?? null}, channel)
            WHERE id = ${pr.id} AND company_id = ${pr.company_id}
          `;
          // If the webhook hasn't run yet, record the receipt so the return
          // page doesn't have to wait for it. Idempotent on the reference, so
          // whichever of the two arrives second records nothing.
          if (mapped === 'completed' && pr.customer_invoice_id) {
            await recordGatewayInvoiceReceipt({
              companyId: pr.company_id,
              invoiceId: pr.customer_invoice_id,
              amountRand: Number(pr.amount_cents) / 100,
              reference: pr.paystack_reference,
              // verifyTransaction reports paidAt but no fee; the webhook, which
              // does carry `fees`, posts the fee leg when it arrives.
              paidAt: live.paidAt ?? null,
            });
          }
        });
        status = mapped;
      }
    } catch (err) {
      log.warn(
        'Paystack live verify failed',
        { prId: pr.id, err: err instanceof Error ? err.message : String(err) },
        'PaystackPortal',
      );
    }
  }

  const publicStatus =
    status === 'completed' ? 'completed'
    : status === 'failed' ? 'failed'
    : status === 'cancelled' || status === 'abandoned' ? 'cancelled'
    : 'pending';

  return apiResponse.success(res, {
    status: publicStatus,
    amountCents: Number(pr.amount_cents),
    invoiceNumber: pr.invoice_number ?? undefined,
    companyName: pr.company_name ?? undefined,
  });
}

export default withErrorHandler(handler);
