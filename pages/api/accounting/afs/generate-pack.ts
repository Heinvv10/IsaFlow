// pages/api/accounting/afs/generate-pack.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withFlowMeter } from '@/lib/billing/withFlowMeter';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { log } from '@/lib/logger';
import { getManagementPackConfig } from '@/modules/accounting/services/afs/managementPackConfigService';
import { generateManagementPack, DuplicatePackError, UnreviewedPackUnavailableError } from '@/modules/accounting/services/afs/managementPackGeneratorService';

const BodySchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period must be YYYY-MM (e.g., 2026-04)'),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  const { period } = parsed.data;

  log.info('Manual pack generation triggered', { companyId, period }, 'generate-pack-api');

  const config = await getManagementPackConfig(companyId);

  try {
    const result = await generateManagementPack({
      companyId,
      period,
      config,
      triggeredBy: 'manual',
    });
    return apiResponse.success(res, { result });
  } catch (err) {
    if (err instanceof DuplicatePackError) {
      return apiResponse.badRequest(res, err.message);
    }
    if (err instanceof UnreviewedPackUnavailableError) {
      return apiResponse.conflict(res, err.message);
    }
    throw err;
  }
}

export default withAuth(
  withErrorHandler(
    withCsrf(withFlowMeter('afs.generate', getFlowCost('afs.generate'))(handler) as never),
  ),
);
