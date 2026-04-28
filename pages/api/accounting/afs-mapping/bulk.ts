// pages/api/accounting/afs-mapping/bulk.ts
// POST — bulk map accounts { mappings: [{ glAccountId, afsLineCode }] }

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { AfsAccountMappingSchema } from '@/lib/schemas/afs';
import { apiResponse } from '@/lib/apiResponse';
import { bulkMapAccounts } from '@/modules/accounting/services/afs/afsMappingService';

const BodySchema = z.object({
  mappings: z.array(AfsAccountMappingSchema).min(1).max(5000),
}).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);

  const { companyId } = req;
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);

  const count = await bulkMapAccounts(companyId, parsed.data.mappings);
  return apiResponse.success(res, { count }, `${count} accounts mapped`);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
