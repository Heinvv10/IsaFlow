/**
 * POST /api/billing/paystack/mandate/revoke
 * Revokes the active Paystack mandate. Queued charges stay queued — they'll
 * skip the next cron run because the mandate is no longer active. If the
 * mandate has a server-side Paystack subscription attached, we disable that
 * too so Paystack stops attempting charges from its side.
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { disableSubscription } from '@/modules/billing/services/paystackClient';

interface Body {
  reason?: string;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { reason } = (req.body ?? {}) as Body;

  const active = await sql<{
    id: string;
    paystack_subscription_code: string | null;
    paystack_email_token: string | null;
  }>`
    SELECT id, paystack_subscription_code, paystack_email_token
    FROM subscription_mandates
    WHERE company_id = ${req.companyId}
      AND gateway = 'paystack'
      AND status = 'active'
    LIMIT 1
  `;
  const mandate = active[0];
  if (!mandate) return apiResponse.notFound(res, 'Active mandate');

  if (mandate.paystack_subscription_code && mandate.paystack_email_token) {
    try {
      await disableSubscription({
        subscriptionCode: mandate.paystack_subscription_code,
        emailToken: mandate.paystack_email_token,
      });
    } catch (err) {
      log.warn(
        'Paystack subscription disable failed (proceeding to local revoke)',
        { mandateId: mandate.id, err: err instanceof Error ? err.message : String(err) },
        'PaystackMandate',
      );
    }
  }

  await sql`
    UPDATE subscription_mandates
    SET status = 'revoked',
        revoked_at = now(),
        revoked_reason = ${reason ?? 'User-initiated revoke'},
        updated_at = now()
    WHERE id = ${mandate.id}
  `;

  return apiResponse.success(res, { mandateId: mandate.id, revoked: true });
}

export default withAuth(withRole('admin')(withErrorHandler(withCsrf(handler))));
