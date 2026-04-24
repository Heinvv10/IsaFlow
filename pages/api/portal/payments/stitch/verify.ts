/**
 * GET /api/portal/payments/stitch/verify?ref=<externalReference>
 * Public — called by /portal/payments/stitch/return to resolve the final
 * status of a payment. We look up by external_reference (we sent it) and,
 * if still pending, re-query Stitch for the live state.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getPaymentStatus } from '@/modules/billing/services/stitchClient';

interface PrRow {
  id: string;
  company_id: string;
  customer_invoice_id: string | null;
  stitch_payment_id: string | null;
  amount_cents: string;
  status: string;
  invoice_number: string | null;
  company_name: string | null;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }
  const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
  if (!ref) return apiResponse.badRequest(res, 'Missing ref');

  const rows = await sql<PrRow>`
    SELECT pr.id, pr.company_id, pr.customer_invoice_id, pr.stitch_payment_id,
           pr.amount_cents, pr.status,
           ci.invoice_number,
           co.name AS company_name
    FROM stitch_payment_requests pr
    LEFT JOIN customer_invoices ci ON ci.id = pr.customer_invoice_id
    LEFT JOIN companies co ON co.id = pr.company_id
    WHERE pr.external_reference = ${ref}
    LIMIT 1
  `;
  const pr = rows[0];
  if (!pr) return apiResponse.notFound(res, 'Payment');

  let status = pr.status;
  if (status === 'pending' && pr.stitch_payment_id) {
    try {
      const live = await getPaymentStatus(pr.stitch_payment_id);
      // Stitch Express "paid" maps to our "completed"; "settled" stays as "settled".
      const mapped =
        live.status === 'paid' ? 'completed'
        : live.status === 'settled' ? 'settled'
        : live.status;
      if (mapped !== status) {
        await sql`
          UPDATE stitch_payment_requests
          SET status = ${mapped},
              completed_at = CASE WHEN ${mapped} IN ('completed','settled') THEN COALESCE(completed_at, now()) ELSE completed_at END
          WHERE id = ${pr.id}
        `;
        status = mapped;
      }
    } catch (err) {
      log.warn(
        'Stitch live status lookup failed',
        { prId: pr.id, err: err instanceof Error ? err.message : String(err) },
        'StitchPortal',
      );
    }
  }

  const publicStatus =
    status === 'completed' || status === 'settled' ? 'completed'
    : status === 'failed' || status === 'expired' ? 'failed'
    : status === 'cancelled' ? 'cancelled'
    : 'pending';

  return apiResponse.success(res, {
    status: publicStatus,
    amountCents: Number(pr.amount_cents),
    invoiceNumber: pr.invoice_number ?? undefined,
    companyName: pr.company_name ?? undefined,
  });
}

export default withErrorHandler(handler);
