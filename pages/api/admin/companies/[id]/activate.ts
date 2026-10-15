/**
 * Admin Company Activate API
 * POST /api/admin/companies/[id]/activate — Reinstate a suspended company
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { activateCompany } from '@/modules/admin/services/adminCompanyService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';


async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = req.query.id as string;

  if (req.method === 'POST') {
    // Not caught: a 4xx would COMMIT an activation whose audit row failed;
    // a thrown error is a 500, which withPlatformAdmin rolls back.
    // A deleted company is not activated: Restore (POST …/restore) brings it back.
    if (!(await activateCompany(companyId))) return apiResponse.notFound(res, 'Company (or it is deleted: use Restore)');

    await logAdminAction(
      req.user.id,
      'company.activate',
      'company',
      companyId,
      null,
      getIp(req)
    );

    return apiResponse.success(res, { activated: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
