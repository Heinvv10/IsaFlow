/**
 * Asset Categories API — SARS Wear-and-Tear Categories
 * GET: list all categories with rates
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const categories = await sql`
    SELECT id, name, code, sars_rate, sars_years, description,
           gl_asset_account_id, gl_depreciation_account_id, gl_expense_account_id,
           is_active,
           useful_life_years, residual_pct, tax_life_years, depreciation_method,
           ias16_group, capitalization_threshold, tax_code, sars_section
    FROM asset_categories
    WHERE is_active = true
    ORDER BY name
  ` as Row[];

  return apiResponse.success(res, categories);
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
