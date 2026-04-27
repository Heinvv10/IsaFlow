/**
 * Admin Add User To Company API
 * POST /api/admin/users/[id]/add-to-company — Add a user to a company with a given role
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { addUserToCompany } from '@/modules/admin/services/adminUserActionsService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { UUID } from '@/lib/schemas/common';

const PostBody = z.object({
  company_id: UUID,
  role:       z.string().min(1).max(50),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = req.query.id as string;

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const { company_id, role } = parsed.data;

      await addUserToCompany(userId, company_id, role);

      await logAdminAction(
        req.user.id,
        'user.add_to_company',
        'user',
        userId,
        { company_id, role },
        getIp(req)
      );

      return apiResponse.success(res, { added: true });
    } catch (err) {
      log.error('Failed to add user to company', { userId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to add user to company');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(withCsrf(handler));
