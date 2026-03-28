/**
 * Asset Categories API — SARS Wear-and-Tear Categories
 * GET: list all categories with rates
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const categories = await sql`
    SELECT id, name, code, sars_rate, sars_years, description,
           gl_asset_account_id, gl_depreciation_account_id, gl_expense_account_id,
           is_active
    FROM asset_categories
    WHERE is_active = true
    ORDER BY name
  ` as Row[];

  return apiResponse.success(res, categories);
}

export default withCompany(withErrorHandler(handler as any));
