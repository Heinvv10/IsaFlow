/**
 * Assets API — CRUD for Fixed Assets
 * GET: list assets (with filters)
 * POST: create new asset
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateAsset, type AssetInput } from '@/modules/accounting/services/items/assetService';
import { createAsset } from '@/modules/accounting/services/items/assetCreateService';

type Row = Record<string, unknown>;

const ASSET_STATUSES: readonly string[] = ['available', 'assigned', 'in_maintenance', 'disposed', 'written_off'];

/**
 * `status` is a single value, a comma list (`available,assigned`) or a repeated
 * param (string[]). Returns the validated list, null for "no filter" (absent, blank
 * or `all`), or an error message for anything outside the asset status enum.
 */
function parseStatusFilter(raw: unknown): { statuses: string[] | null; error?: string } {
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return { statuses: null };
  if (typeof raw !== 'string' && !(Array.isArray(raw) && raw.every(v => typeof v === 'string'))) {
    return { statuses: null, error: 'status must be a string' };
  }
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap(v => (v as string).split(',')).map(v => v.trim());
  if (parts.length === 1 && parts[0] === 'all') return { statuses: null };
  if (parts.some(v => !ASSET_STATUSES.includes(v))) {
    return { statuses: null, error: `Invalid status. Must be one of: ${ASSET_STATUSES.join(', ')}` };
  }
  return { statuses: parts };
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { category, search } = req.query;
    const { statuses, error: statusError } = parseStatusFilter(req.query.status);
    if (statusError) return apiResponse.badRequest(res, statusError);

    let rows: Row[];

    if (search) {
      const term = `%${String(search)}%`;
      rows = await sql`
        SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years
        FROM assets a LEFT JOIN asset_categories ac ON a.category_id = ac.id
        WHERE a.company_id = ${companyId}::UUID AND (a.name ILIKE ${term} OR a.asset_number ILIKE ${term} OR a.serial_number ILIKE ${term})
        ORDER BY a.created_at DESC LIMIT 200
      ` as Row[];
    } else if (statuses && category) {
      rows = await sql`
        SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years
        FROM assets a LEFT JOIN asset_categories ac ON a.category_id = ac.id
        WHERE a.company_id = ${companyId}::UUID AND a.status = ANY(${statuses}::TEXT[]) AND (a.category = ${String(category)} OR ac.code = ${String(category)})
        ORDER BY a.created_at DESC LIMIT 200
      ` as Row[];
    } else if (statuses) {
      rows = await sql`
        SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years
        FROM assets a LEFT JOIN asset_categories ac ON a.category_id = ac.id
        WHERE a.company_id = ${companyId}::UUID AND a.status = ANY(${statuses}::TEXT[])
        ORDER BY a.created_at DESC LIMIT 200
      ` as Row[];
    } else if (category) {
      rows = await sql`
        SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years
        FROM assets a LEFT JOIN asset_categories ac ON a.category_id = ac.id
        WHERE a.company_id = ${companyId}::UUID AND (a.category = ${String(category)} OR ac.code = ${String(category)})
        ORDER BY a.created_at DESC LIMIT 200
      ` as Row[];
    } else {
      rows = await sql`
        SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years
        FROM assets a LEFT JOIN asset_categories ac ON a.category_id = ac.id
        WHERE a.company_id = ${companyId}::UUID
        ORDER BY a.created_at DESC LIMIT 200
      ` as Row[];
    }

    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    const body = req.body as AssetInput;

    const validation = validateAsset(body);
    if (!validation.success) {
      return apiResponse.validationError(res,
        Object.fromEntries((validation.errors || []).map(e => [e.field, e.message]))
      );
    }

    const created = await createAsset(companyId, String(req.user.id), body);

    log.info('Asset created', { assetNumber: created.asset_number, name: body.name }, 'accounting');
    return apiResponse.created(res, created);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
