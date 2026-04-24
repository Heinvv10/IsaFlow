/**
 * POST /api/admin/billing/stitch/mandate/revoke
 * Revokes the currently active LinkPay mandate. Queued charges stay queued
 * (they'll skip next cron run because the mandate is no longer active).
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';

interface Body {
  reason?: string;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { reason } = (req.body ?? {}) as Body;

  const updated = await sql<{ id: string }>`
    UPDATE subscription_mandates
    SET status = 'revoked',
        revoked_at = now(),
        revoked_reason = ${reason ?? 'User-initiated revoke'}
    WHERE company_id = ${req.companyId}
      AND status = 'active'
    RETURNING id
  `;

  if (!updated[0]) return apiResponse.notFound(res, 'Active mandate');
  return apiResponse.success(res, { mandateId: updated[0].id, revoked: true });
}

export default withAuth(withRole('admin')(withErrorHandler(handler)));
