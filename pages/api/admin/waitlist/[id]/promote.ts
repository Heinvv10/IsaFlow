/**
 * POST /api/admin/waitlist/:id/promote — promote a waitlist lead into a tenant.
 *
 * Body (all optional):
 *   { planCodeOverride?: string | null }
 *
 * Returns:
 *   200 { status: 'promoted' | 'already_promoted', companyId, planCode, seed? }
 *   404 when the waitlist id does not exist
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import type { PlatformAdminRequest } from '@/lib/auth/withPlatformAdmin';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { promoteWaitlistSignup } from '@/modules/onboarding/services/waitlistPromotionService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const UUID = z.string().uuid();
const Body = z.object({
  planCodeOverride: z.string().max(64).nullable().optional(),
}).strict();

async function handler(req: PlatformAdminRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { id } = req.query;
  const parsedId = UUID.safeParse(id);
  if (!parsedId.success) return apiResponse.badRequest(res, 'Invalid waitlist id');

  const parsedBody = Body.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    return apiResponse.badRequest(res, parsedBody.error.flatten().formErrors[0] ?? 'Invalid input');
  }

  try {
    const result = await promoteWaitlistSignup(parsedId.data, {
      planCodeOverride: parsedBody.data.planCodeOverride ?? null,
    });

    if (result.status === 'not_found') {
      return apiResponse.notFound(res, 'Waitlist signup not found');
    }

    if (result.status === 'promoted') {
      await logAdminAction(
        req.user.id,
        'waitlist.promote',
        'waitlist_signup',
        parsedId.data,
        {
          companyId:     result.companyId,
          planCode:      result.planCode,
          paygEligible:  result.seed?.paygEligible ?? false,
          turnoverCents: result.seed?.annualTurnoverCents ?? null,
        },
        getIp(req),
      );
    }

    return apiResponse.success(res, {
      status:    result.status,
      companyId: result.companyId,
      planCode:  result.planCode,
      seed:      result.seed,
    });
  } catch (err) {
    log.error('Failed to promote waitlist signup', { id: parsedId.data, error: err }, 'admin-api');
    return apiResponse.badRequest(res, 'Failed to promote waitlist signup');
  }
}

export default withAdmin(handler);
