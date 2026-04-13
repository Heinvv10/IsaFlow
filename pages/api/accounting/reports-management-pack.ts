/**
 * Management Pack Report API
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { sql } from '@/lib/neon';
import { buildManagementPack } from '@/modules/accounting/services/reports/reportingEngineService';
import type { CompanyApiRequest } from '@/lib/auth/withCompany';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const companyId = (req as CompanyApiRequest).companyId;
  const period = String(req.query.period || new Date().toISOString().slice(0, 7));

  const companies = await sql`SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1` as Row[];
  const companyName = String(companies[0]?.name || 'Company');

  const pack = buildManagementPack({
    companyName,
    period,
    revenue: 0, expenses: 0, netProfit: 0,
    cashBalance: 0, arOutstanding: 0, apOutstanding: 0,
  });

  return apiResponse.success(res, pack);
}
export default withCompany(withErrorHandler(withWriteAccess(handler)));
