/**
 * Admin Company Suspend API
 * POST /api/admin/companies/[id]/suspend — Suspend a company
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { suspendCompany } from '@/modules/admin/services/adminCompanyService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { isUuidParam } from '@/lib/validation';

const PostBody = z.object({
  reason: z.string().min(1).max(500),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = req.query.id;
  if (!isUuidParam(companyId)) return apiResponse.badRequest(res, 'Invalid company id');

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'A suspension reason is required');
    }

    const { reason } = parsed.data;

    // Not caught: a 4xx would COMMIT a suspension whose audit row failed; a
    // thrown error is a 500, which withPlatformAdmin rolls back. A deleted
    // company is refused: suspending it would undelete it.
    if (!(await suspendCompany(companyId, reason.trim()))) {
      return apiResponse.notFound(res, 'Company (or it is deleted: use Restore)');
    }

    await logAdminAction(
      req.user.id,
      'company.suspend',
      'company',
      companyId,
      { reason: reason.trim() },
      getIp(req)
    );

    return apiResponse.success(res, { suspended: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
