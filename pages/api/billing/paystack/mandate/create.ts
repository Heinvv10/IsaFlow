/**
 * POST /api/billing/paystack/mandate/create
 *
 * Starts a Paystack authorisation flow that captures a reusable
 * authorization_code for recurring SaaS billing (startMandateCheckout:
 * a small verification charge, a pending mandate row on the migration_admin
 * pool, the payment request on the request's transaction). The payer returns
 * to the admin mandate-return page.
 *
 * Body: { maxAmountCents: number }  // billing ceiling: runQueuedCharges never debits above it
 * Returns: { checkoutUrl: string, reference: string, mandateId: string }
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth, withRole, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { startMandateCheckout } from '@/modules/billing/services/mandateCheckout';

const Body = z.object({
  maxAmountCents: z.number().int().positive(),
}).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  const result = await startMandateCheckout({
    companyId: req.companyId,
    userId: req.user!.id,
    userEmail: req.user?.email,
    maxAmountCents: parsed.data.maxAmountCents,
    callbackUrl: (reference) =>
      `${process.env.NEXT_PUBLIC_APP_URL}/admin/billing/paystack/return?ref=${encodeURIComponent(reference)}`,
  });

  switch (result.kind) {
    case 'active_exists':
      return apiResponse.badRequest(res, 'An active mandate already exists. Revoke it before creating a new one.');
    case 'no_email':
      return apiResponse.badRequest(res, 'No authorised user email available for mandate authorisation');
    case 'init_failed':
      return apiResponse.internalError(res, 'Failed to initialise mandate authorisation');
    case 'started':
      return apiResponse.success(res, {
        checkoutUrl: result.checkoutUrl,
        reference: result.reference,
        mandateId: result.mandateId,
      });
  }
}

export default withAuth(withRole('admin')(withErrorHandler(withCsrf(handler))));
