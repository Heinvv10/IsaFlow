/**
 * GET /api/accounting/setup-guide
 * Returns auto-detected completed task IDs based on company data.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { probeSetupFacts, completedGuideTasks } from '@/modules/accounting/services/core/setupProgressService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const completedTasks = completedGuideTasks(await probeSetupFacts(companyId));

  log.info('Setup guide status fetched', { companyId, completed: completedTasks.length }, 'setup-guide');
  return apiResponse.success(res, { completedTasks });
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
