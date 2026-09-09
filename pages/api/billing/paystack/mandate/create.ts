/**
 * POST /api/billing/paystack/mandate/create
 *
 * Starts a Paystack authorisation flow that captures a reusable
 * authorization_code for recurring SaaS billing. We initialise a small
 * verification charge (R1, refundable later if needed) — Paystack hands back
 * the authorization_code on charge.success, which the webhook promotes onto
 * the company's subscription_mandates row.
 *
 * Body: { maxAmountCents: number }  // billing ceiling (display only)
 * Returns: { checkoutUrl: string, reference: string }
 */

import type { NextApiResponse } from 'next';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { withAuth, withRole, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { initializeTransaction } from '@/modules/billing/services/paystackClient';

const Body = z.object({
  maxAmountCents: z.number().int().positive(),
}).strict();

// Verification charge — small enough to be cheap, large enough to actually
// authorise the card. R1.00 (100 cents). Will be visible on the cardholder's
// statement, so document this clearly in the admin UI copy.
const AUTH_VERIFICATION_CENTS = 100;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  // Don't allow stacking active mandates — revoke first.
  const existing = await sql<{ id: string }>`
    SELECT id FROM subscription_mandates
    WHERE company_id = ${req.companyId}
      AND status = 'active'
    LIMIT 1
  `;
  if (existing[0]) {
    return apiResponse.badRequest(res, 'An active mandate already exists. Revoke it before creating a new one.');
  }

  const userEmail = req.user?.email;
  if (!userEmail) {
    return apiResponse.badRequest(res, 'No authorised user email available for mandate authorisation');
  }

  const reference = `auth_${req.companyId.replace(/-/g, '').slice(0, 12)}_${randomBytes(6).toString('hex')}`;
  const callbackUrl = `${process.env.NEXT_PUBLIC_APP_URL}/admin/billing/paystack/return?ref=${encodeURIComponent(reference)}`;

  // Insert a pending mandate row so the webhook has somewhere to attach the
  // captured authorization_code. status='pending' until charge.success fires.
  // Its id is stored on the payment request below (migration 651) so both the
  // webhook and the verify route write to THIS mandate rather than guessing
  // from the company's newest pending row.
  const mandateRows = await sql<{ id: string }>`
    INSERT INTO subscription_mandates (
      company_id, gateway, max_amount_cents, currency,
      authorised_by, status
    ) VALUES (
      ${req.companyId}, 'paystack', ${parsed.data.maxAmountCents}, 'ZAR',
      ${req.user!.id}, 'pending'
    )
    RETURNING id
  `;
  const mandateId = mandateRows[0]!.id;

  try {
    const init = await initializeTransaction({
      email: userEmail,
      amountCents: AUTH_VERIFICATION_CENTS,
      reference,
      callbackUrl,
      metadata: {
        purpose: 'mandate_authorisation',
        company_id: req.companyId,
        mandate_id: mandateId,
        max_amount_cents: parsed.data.maxAmountCents,
      },
    });

    await sql`
      INSERT INTO paystack_payment_requests (
        company_id, purpose, mandate_id,
        paystack_reference, paystack_access_code, authorization_url,
        amount_cents, currency, status, payer_email
      ) VALUES (
        ${req.companyId}, 'authorization', ${mandateId},
        ${init.reference}, ${init.accessCode}, ${init.authorizationUrl},
        ${AUTH_VERIFICATION_CENTS}, 'ZAR', 'pending', ${userEmail}
      )
    `;

    return apiResponse.success(res, {
      checkoutUrl: init.authorizationUrl,
      reference: init.reference,
      mandateId,
    });
  } catch (err) {
    await sql`
      UPDATE subscription_mandates SET status = 'failed', updated_at = now()
      WHERE id = ${mandateId}
    `;
    log.error(
      'Paystack mandate authorisation failed to initialise',
      { mandateId, err: err instanceof Error ? err.message : String(err) },
      'PaystackMandate',
    );
    return apiResponse.internalError(res, 'Failed to initialise mandate authorisation');
  }
}

export default withAuth(withRole('admin')(withErrorHandler(withCsrf(handler))));
