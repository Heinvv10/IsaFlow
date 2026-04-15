/**
 * Admin Trials — Convert to Paid
 * POST /api/admin/trials/convert
 * Body: { companyId: string; planId: string }
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { markAsConverted } from '@/modules/admin/services/trialService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { UUID } from '@/lib/schemas/common';

const PostBody = z.object({
  companyId: UUID,
  planId:    UUID,
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
  }

  const { companyId, planId } = parsed.data;

  try {
    await markAsConverted(companyId, planId);

    await logAdminAction(
      req.user.id,
      'trial.convert_to_paid',
      'company',
      companyId,
      { planId },
      getIp(req),
    );

    log.info('Trial converted to paid', { companyId, planId }, 'admin-trials-convert');
    return apiResponse.success(res, { companyId, planId, converted: true });
  } catch (err) {
    log.error('Failed to convert trial', { companyId, planId, error: err }, 'admin-trials-convert');
    return apiResponse.badRequest(
      res,
      err instanceof Error ? err.message : 'Failed to convert trial',
    );
  }
}

export default withAdmin(handler);
