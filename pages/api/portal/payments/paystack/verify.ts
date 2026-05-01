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
import { verifyTransaction } from '@/modules/billing/services/paystackClient';

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
        await sql`
          UPDATE paystack_payment_requests
          SET status = ${mapped},
              completed_at = CASE WHEN ${mapped} = 'completed' THEN COALESCE(completed_at, now()) ELSE completed_at END,
              paystack_transaction_id = ${live.id ?? null},
              paystack_authorization_code = COALESCE(${live.authorization?.authorizationCode ?? null}, paystack_authorization_code),
              channel = COALESCE(${live.channel ?? null}, channel)
          WHERE id = ${pr.id}
        `;
        // If the webhook hasn't run yet, also apply the invoice-paid update so
        // the return page doesn't have to wait for it.
        if (mapped === 'completed' && pr.customer_invoice_id) {
          const amountRand = Number(pr.amount_cents) / 100;
          await sql`
            UPDATE customer_invoices
            SET amount_paid = LEAST(total_amount, COALESCE(amount_paid, 0) + ${amountRand}),
                status = CASE
                  WHEN COALESCE(amount_paid, 0) + ${amountRand} >= total_amount THEN 'paid'
                  ELSE status
                END,
                updated_at = now()
            WHERE id = ${pr.customer_invoice_id} AND company_id = ${pr.company_id}
              AND NOT EXISTS (
                SELECT 1 FROM paystack_payment_requests p2
                WHERE p2.id = ${pr.id} AND p2.completed_at < now() - INTERVAL '1 second'
              )
          `;
        }
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
