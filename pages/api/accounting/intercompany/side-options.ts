/** GET — the customers, suppliers and postable accounts of this company that a connection side can point at. */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { listSideOptions } from '@/modules/accounting/services/intercompany/connectionOptions';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  return apiResponse.success(res, await listSideOptions(req.companyId));
}

export default withAuth(withErrorHandler(handler));
