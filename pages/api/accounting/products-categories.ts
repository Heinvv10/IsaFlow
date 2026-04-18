/**
 * Product Categories API
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { sql } from '@/lib/neon';
type Row = Record<string, unknown>;
async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const companyId = req.companyId;
  const categories = await sql`
    SELECT * FROM product_categories
    WHERE is_active = true
      AND (company_id = ${companyId}::UUID OR company_id IS NULL)
    ORDER BY name
  ` as Row[];
  return apiResponse.success(res, categories);
}
export default withAuth(withErrorHandler(withWriteAccess(handler)));
