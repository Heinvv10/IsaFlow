/**
 * POST /api/admin/billing/payg/[companyId]/eligibility
 * Toggle `companies.payg_eligible` — the admin override gate from the spec §3.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import type { PlatformAdminRequest } from '@/lib/auth';

const Body = z.object({
  eligible: z.boolean(),
  reason:   z.string().max(500).optional(),
}).strict();

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req.query;
  if (typeof companyId !== 'string' || !companyId) {
    return apiResponse.badRequest(res, 'companyId is required');
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
  }

  const rows = (await sql`
    UPDATE companies SET payg_eligible = ${parsed.data.eligible}
     WHERE id = ${companyId}
    RETURNING id, payg_eligible
  `) as Array<{ id: string; payg_eligible: boolean }>;

  if (rows.length === 0) {
    return apiResponse.notFound(res, 'Company', companyId);
  }

  await logAdminAction(
    req.user.id,
    'flow.eligibility',
    'company',
    companyId,
    { eligible: parsed.data.eligible, reason: parsed.data.reason },
    getIp(req),
  );

  return apiResponse.success(res, { companyId, eligible: rows[0]!.payg_eligible });
}

export default withAdmin(handler);
