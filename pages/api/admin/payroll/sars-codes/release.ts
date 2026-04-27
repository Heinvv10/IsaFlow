/**
 * POST /api/admin/payroll/sars-codes/release
 *
 * Body: { taxYear: number }
 * Marks the given tax year as the current SARS code release. Only one
 * release can be current at a time. Admin auth required.
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
import { setCurrentRelease } from '@/modules/admin/services/sarsCodesAdminService';

const Body = z.object({ taxYear: z.number().int().min(2000).max(2100) }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
  }

  try {
    await setCurrentRelease(parsed.data.taxYear);

    await logAdminAction(
      req.user.id,
      'sars_codes.set_current',
      'sars_code_release',
      String(parsed.data.taxYear),
      { tax_year: parsed.data.taxYear },
      getIp(req)
    );

    return apiResponse.success(res, { taxYear: parsed.data.taxYear, isCurrent: true });
  } catch (err) {
    log.error('Failed to set current SARS release', { error: err }, 'admin-api');
    return apiResponse.badRequestFromError(res, err, 'Failed');
  }
}

export default withAdmin(withCsrf(handler));
