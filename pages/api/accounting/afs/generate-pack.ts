// pages/api/accounting/afs/generate-pack.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getManagementPackConfig } from '@/modules/accounting/services/afs/managementPackConfigService';
import { generateManagementPack, DuplicatePackError } from '@/modules/accounting/services/afs/managementPackGeneratorService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { period } = req.body as { period?: string };

  if (typeof period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    return apiResponse.badRequest(res, 'period must be YYYY-MM (e.g., 2026-04)');
  }

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
    throw err;
  }
}

export default withCompany(withErrorHandler(handler as never));
