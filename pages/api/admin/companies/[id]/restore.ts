/**
 * Admin Company Restore API
 * POST /api/admin/companies/[id]/restore — Undo a (soft) company delete
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { restoreCompany } from '@/modules/admin/services/companyLifecycleService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = req.query.id as string;

  if (req.method === 'POST') {
    // A failure is thrown, not answered 4xx: withPlatformAdmin rolls a 5xx back.
    if (!(await restoreCompany(companyId))) return apiResponse.notFound(res, 'Deleted company');

    await logAdminAction(req.user.id, 'company.restore', 'company', companyId, null, getIp(req));
    return apiResponse.success(res, { restored: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
