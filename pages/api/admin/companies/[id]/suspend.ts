/**
 * Admin Company Suspend API
 * POST /api/admin/companies/[id]/suspend — Suspend a company
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { suspendCompany } from '@/modules/admin/services/adminCompanyService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PostBody = z.object({
  reason: z.string().min(1).max(500),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = req.query.id as string;

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'A suspension reason is required');
    }

    try {
      const { reason } = parsed.data;

      await suspendCompany(companyId, reason.trim());

      await logAdminAction(
        req.user.id,
        'company.suspend',
        'company',
        companyId,
        { reason: reason.trim() },
        getIp(req)
      );

      return apiResponse.success(res, { suspended: true });
    } catch (err) {
      log.error('Failed to suspend company', { companyId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to suspend company');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(handler);
