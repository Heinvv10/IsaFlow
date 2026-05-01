/**
 * GET /api/billing/paystack/mandate/verify?ref=<reference>
 *
 * Called by the admin mandate-return landing page. If the webhook hasn't
 * arrived yet, we re-query Paystack and (if successful) promote the captured
 * authorization onto the pending mandate row inline so the UI doesn't have
 * to wait. Always scoped by company_id.
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { verifyTransaction } from '@/modules/billing/services/paystackClient';

interface Row {
  pr_id: string;
  pr_status: string;
  paystack_reference: string;
  mandate_id: string | null;
  mandate_status: string | null;
  max_amount_cents: string | null;
  bank_name: string | null;
  card_last4: string | null;
  card_brand: string | null;
  authorised_at: Date | string | null;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }
  const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
  if (!ref) return apiResponse.badRequest(res, 'Missing ref');

  const rows = await sql<Row>`
    SELECT pr.id AS pr_id, pr.status AS pr_status, pr.paystack_reference,
           m.id AS mandate_id, m.status AS mandate_status,
           m.max_amount_cents, m.bank_name,
           m.card_last4, m.card_brand,
           m.authorised_at
    FROM paystack_payment_requests pr
    LEFT JOIN subscription_mandates m
      ON m.company_id = pr.company_id
     AND m.gateway = 'paystack'
     AND m.status IN ('pending','active')
    WHERE pr.paystack_reference = ${ref}
      AND pr.company_id = ${req.companyId}
      AND pr.purpose = 'authorization'
    ORDER BY (m.status = 'active') DESC NULLS LAST, m.created_at DESC NULLS LAST
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return apiResponse.notFound(res, 'Mandate');

  // If the webhook hasn't fired, ask Paystack directly. The webhook is the
  // source of truth long-term — this is just to avoid stalling the UI.
  if (row.pr_status === 'pending') {
    try {
      const live = await verifyTransaction(row.paystack_reference);
      if (live.status === 'success' && live.authorization?.authorizationCode) {
        await sql`
          UPDATE paystack_payment_requests
          SET status = 'completed',
              completed_at = COALESCE(completed_at, now()),
              paystack_transaction_id = ${live.id ?? null},
              paystack_authorization_code = ${live.authorization.authorizationCode},
              paystack_customer_code = ${live.customer?.customerCode ?? null}
          WHERE id = ${row.pr_id}
        `;
        await sql`
          UPDATE subscription_mandates
          SET status = 'active',
              gateway = 'paystack',
              paystack_authorization_code = ${live.authorization.authorizationCode},
              paystack_customer_code = ${live.customer?.customerCode ?? null},
              card_last4 = ${live.authorization.last4 ?? null},
              card_brand = ${live.authorization.brand ?? null},
              card_exp_month = ${live.authorization.expMonth ?? null},
              card_exp_year = ${live.authorization.expYear ?? null},
              bank_name = COALESCE(${live.authorization.bank ?? null}, bank_name),
              authorised_at = COALESCE(authorised_at, now()),
              updated_at = now()
          WHERE company_id = ${req.companyId}
            AND status = 'pending'
            AND gateway = 'paystack'
        `;
      } else if (live.status === 'failed' || live.status === 'abandoned') {
        await sql`
          UPDATE paystack_payment_requests SET status = 'failed' WHERE id = ${row.pr_id}
        `;
        await sql`
          UPDATE subscription_mandates SET status = 'failed', updated_at = now()
          WHERE company_id = ${req.companyId} AND status = 'pending' AND gateway = 'paystack'
        `;
      }
    } catch (err) {
      log.warn(
        'Paystack mandate live verify failed',
        { prId: row.pr_id, err: err instanceof Error ? err.message : String(err) },
        'PaystackMandate',
      );
    }
  }

  // Re-read the canonical state.
  const fresh = await sql<{ status: string; bank_name: string | null; card_last4: string | null; card_brand: string | null; max_amount_cents: string | null; authorised_at: Date | string | null; id: string }>`
    SELECT id, status, bank_name, card_last4, card_brand, max_amount_cents, authorised_at
    FROM subscription_mandates
    WHERE company_id = ${req.companyId}
      AND gateway = 'paystack'
      AND status IN ('active','pending','failed')
    ORDER BY (status = 'active') DESC, created_at DESC
    LIMIT 1
  `;
  const m = fresh[0];

  const publicStatus =
    m?.status === 'active' ? 'active'
    : m?.status === 'failed' ? 'failed'
    : 'pending';

  return apiResponse.success(res, {
    status: publicStatus,
    mandateId: m?.id ?? null,
    bankName: m?.bank_name ?? undefined,
    cardLast4: m?.card_last4 ?? undefined,
    cardBrand: m?.card_brand ?? undefined,
    maxAmountCents: m?.max_amount_cents ? Number(m.max_amount_cents) : undefined,
  });
}

export default withAuth(withErrorHandler(handler));
