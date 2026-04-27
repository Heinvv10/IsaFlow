/**
 * Admin: convert a 'direct' user into a bureau owner.
 *
 * POST /api/admin/users/[id]/convert-to-bureau
 * Body: { bureauName: string }
 *
 * Idempotent — if the user already owns a bureau with that name it returns
 * the existing one. Flips users.account_type to 'bureau_owner'. Used to
 * onboard accountants who signed up through the direct flow.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { convertUserToBureauOwner } from '@/modules/bureau/services/bureauService';

const Body = z.object({ bureauName: z.string().min(1).max(200) }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const userId = String(req.query.id ?? '');
  if (!userId) {
    return apiResponse.badRequest(res, 'Missing user id');
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
  }

  try {
    const bureau = await convertUserToBureauOwner({
      userId,
      bureauName: parsed.data.bureauName.trim(),
    });

    await logAdminAction(
      req.user.id,
      'user.convert_to_bureau',
      'user',
      userId,
      { bureau_id: bureau.id, bureau_name: bureau.name },
      getIp(req)
    );

    return apiResponse.success(res, {
      bureauId: bureau.id,
      bureauName: bureau.name,
      ownerUserId: bureau.ownerUserId,
    });
  } catch (err) {
    log.error('Failed to convert user to bureau', { userId, error: err }, 'admin-api');
    return apiResponse.badRequestFromError(res, err, 'Failed');
  }
}

export default withAdmin(withCsrf(handler));
