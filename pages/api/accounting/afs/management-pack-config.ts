// pages/api/accounting/afs/management-pack-config.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  getManagementPackConfig,
  upsertManagementPackConfig,
} from '@/modules/accounting/services/afs/managementPackConfigService';
import type { ManagementPackConfig } from '@/modules/accounting/services/afs/afsTypes';

const RecipientSchema = z.object({
  email: z.string().email().max(254),
  role: z.string().min(1).max(100),
  receives: z.enum(['draft', 'final', 'both']),
});

const PutConfigSchema = z.object({
  deliveryDay: z.number().int().min(1).max(28).optional(),
  generationDay: z.number().int().min(1).max(28).optional(),
  packStyle: z.enum(['executive', 'detailed', 'board']).optional(),
  comparisonMode: z.enum(['prior_month', 'prior_year', 'budget', 'all_three']).optional(),
  currencyDisplay: z.enum(['full', 'thousands', 'millions']).optional(),
  recipients: z.array(RecipientSchema).max(50).optional(),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    log.info('Fetching management pack config', { companyId }, 'management-pack-config-api');
    const config = await getManagementPackConfig(companyId);
    return apiResponse.success(res, { config });
  }

  if (req.method === 'PUT') {
    const parsed = PutConfigSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return apiResponse.validationError(
        res,
        parsed.error.flatten().fieldErrors as Record<string, string | string[]>,
      );
    }
    log.info('Upserting management pack config', { companyId }, 'management-pack-config-api');
    const config = await upsertManagementPackConfig(companyId, parsed.data as Partial<ManagementPackConfig>);
    return apiResponse.success(res, { config });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
