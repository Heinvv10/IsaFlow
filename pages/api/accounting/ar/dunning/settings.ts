/**
 * GET /api/accounting/ar/dunning/settings
 * PUT /api/accounting/ar/dunning/settings
 *   body: { auto_send_enabled?: boolean, min_outstanding_zar?: number }
 *
 * Per-company auto-send opt-in. Default (row absent) is opt-out.
 * PRD-06 Phase 5. Company-scoped, write-only (manager+).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  getSettings,
  updateSettings,
} from '@/modules/accounting/services/ar/dunningAdmin';

const SettingsPatchSchema = z.object({
  auto_send_enabled: z.boolean().optional(),
  min_outstanding_zar: z.union([z.number(), z.string()])
    .transform(v => Number(v))
    .refine(n => Number.isFinite(n) && n >= 0, { message: 'min_outstanding_zar must be ≥ 0' })
    .optional(),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const settings = await getSettings(companyId);
    apiResponse.success(res, { settings });
    return;
  }

  if (req.method === 'PUT') {
    const parsed = SettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
      return;
    }
    const settings = await updateSettings(companyId, parsed.data);
    apiResponse.success(res, { settings });
    return;
  }

  apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
