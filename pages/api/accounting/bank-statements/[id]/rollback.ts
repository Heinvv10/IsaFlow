/**
 * POST /api/accounting/bank-statements/[id]/rollback
 * Flips status → 'rolled_back'. Only valid before commit.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { rollbackImport } from '@/modules/accounting/services/bank/bankStatementOcrService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);

  const { companyId } = req;
  const userId = req.user.id;
  const { id } = req.query as { id: string };

  await rollbackImport(companyId, id, userId);
  return apiResponse.success(res, { rolled_back: true });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
