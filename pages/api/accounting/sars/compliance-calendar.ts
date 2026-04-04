/**
 * SARS Compliance Calendar API
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { calculateComplianceDeadlines } from '@/modules/accounting/services/sarsEfilingService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const parsedYear = Number(req.query.year);
  const year = parsedYear >= 2000 && parsedYear <= 2100 ? parsedYear : new Date().getFullYear();
  const deadlines = calculateComplianceDeadlines(year);
  return apiResponse.success(res, { year, deadlines, total: deadlines.length });
}
export default withCompany(withErrorHandler(handler));
