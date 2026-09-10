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
import { validateAsset, generateAssetNumber, type AssetInput } from '@/modules/accounting/services/items/assetService';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { status, category, search } = req.query;

    let rows: Row[];

    if (search) {
      const term = `%${String(search)}%`;
      rows = await sql`
        SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years
        FROM assets a LEFT JOIN asset_categories ac ON a.category_id = ac.id
        WHERE a.company_id = ${companyId}::UUID AND (a.name ILIKE ${term} OR a.asset_number ILIKE ${term} OR a.serial_number ILIKE ${term})
        ORDER BY a.created_at DESC LIMIT 200
      ` as Row[];
    } else if (status && status !== 'all' && category) {
      rows = await sql`
        SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years
        FROM assets a LEFT JOIN asset_categories ac ON a.category_id = ac.id
        WHERE a.company_id = ${companyId}::UUID AND a.status = ${String(status)} AND (a.category = ${String(category)} OR ac.code = ${String(category)})
        ORDER BY a.created_at DESC LIMIT 200
      ` as Row[];
    } else if (status && status !== 'all') {
      rows = await sql`
        SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years
        FROM assets a LEFT JOIN asset_categories ac ON a.category_id = ac.id
        WHERE a.company_id = ${companyId}::UUID AND a.status = ${String(status)}
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

    let categoryId: string | null = null;
    let sarsRate: number | null = null;
    let taxLife: number | null = null;

    if (body.sarsCategory || body.category) {
      const catCode = body.sarsCategory || body.category;
      const cats = await sql`
        SELECT id, sars_rate, sars_years FROM asset_categories WHERE code = ${catCode} LIMIT 1
      ` as Row[];
      if (cats[0]) {
        categoryId = String(cats[0].id);
        sarsRate = Number(cats[0].sars_rate);
        taxLife = Number(cats[0].sars_years);
      }
    }

    const catKey = body.category || body.sarsCategory || 'general';
    // MAX of the numbers ALREADY MINTED under this category's prefix, not a
    // COUNT of the category's rows: assets carries UNIQUE(company_id,
    // asset_number), and count is not max — after a single asset was deleted
    // every later create in that category re-issued an existing number and
    // 23505'd permanently, since the count never caught up.
    const assetPrefix = generateAssetNumber(body.sarsCategory || body.category || 'general', 0).split('-')[0]!;
    const maxResult = await sql`
      SELECT COALESCE(MAX(CAST(SUBSTRING(asset_number FROM '[0-9]+$') AS INTEGER)), 0) AS max_num
      FROM assets
      WHERE company_id = ${companyId}::UUID AND asset_number LIKE ${assetPrefix + '-%'}
    ` as Row[];
    const assetNumber = generateAssetNumber(body.sarsCategory || body.category || 'general', Number(maxResult[0]?.max_num ?? 0));

    const inserted = await sql`
      INSERT INTO assets (
        company_id, asset_number, name, description, category_id, category,
        serial_number, location, purchase_date, purchase_price,
        salvage_value, useful_life_years, depreciation_method,
        sars_category, sars_rate, tax_useful_life_years, tax_depreciation_method,
        status, created_by
      ) VALUES (
        ${companyId}::UUID, ${assetNumber}, ${body.name}, ${body.description || null},
        ${categoryId}, ${catKey},
        ${body.serialNumber || null}, ${body.location || null},
        ${body.purchaseDate}, ${body.cost},
        ${body.salvageValue || 0}, ${body.usefulLifeYears}, ${body.depreciationMethod || 'straight_line'},
        ${body.sarsCategory || null}, ${sarsRate}, ${taxLife}, ${'straight_line'},
        ${body.status || 'available'}, ${String(req.user.id)}
      ) RETURNING *
    ` as Row[];

    log.info('Asset created', { assetNumber, name: body.name }, 'accounting');
    return apiResponse.created(res, inserted[0]);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
