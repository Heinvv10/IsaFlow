/**
 * Assets API — CRUD for Fixed Assets
 * GET: list assets (with filters)
 * POST: create new asset
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateAsset, generateAssetNumber, type AssetInput } from '@/modules/accounting/services/assetService';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const { status, category, search } = req.query;

    let rows: Row[];

    if (search) {
      const term = `%${String(search)}%`;
      rows = await sql`
        SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years
        FROM assets a LEFT JOIN asset_categories ac ON a.category_id = ac.id
        WHERE (a.name ILIKE ${term} OR a.asset_number ILIKE ${term} OR a.serial_number ILIKE ${term})
        ORDER BY a.created_at DESC LIMIT 200
      ` as Row[];
    } else if (status && status !== 'all' && category) {
      rows = await sql`
        SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years
        FROM assets a LEFT JOIN asset_categories ac ON a.category_id = ac.id
        WHERE a.status = ${String(status)} AND (a.category = ${String(category)} OR ac.code = ${String(category)})
        ORDER BY a.created_at DESC LIMIT 200
      ` as Row[];
    } else if (status && status !== 'all') {
      rows = await sql`
        SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years
        FROM assets a LEFT JOIN asset_categories ac ON a.category_id = ac.id
        WHERE a.status = ${String(status)}
        ORDER BY a.created_at DESC LIMIT 200
      ` as Row[];
    } else if (category) {
      rows = await sql`
        SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years
        FROM assets a LEFT JOIN asset_categories ac ON a.category_id = ac.id
        WHERE a.category = ${String(category)} OR ac.code = ${String(category)}
        ORDER BY a.created_at DESC LIMIT 200
      ` as Row[];
    } else {
      rows = await sql`
        SELECT a.*, ac.name as category_name, ac.sars_rate, ac.sars_years
        FROM assets a LEFT JOIN asset_categories ac ON a.category_id = ac.id
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
    const countResult = await sql`
      SELECT COUNT(*) as cnt FROM assets WHERE category = ${catKey}
    ` as Row[];
    const existingCount = Number((countResult[0] as any)?.cnt || 0);
    const assetNumber = generateAssetNumber(body.sarsCategory || body.category || 'general', existingCount);

    const inserted = await sql`
      INSERT INTO assets (
        asset_number, name, description, category_id, category,
        serial_number, location, purchase_date, purchase_price,
        salvage_value, useful_life_years, depreciation_method,
        sars_category, sars_rate, tax_useful_life_years, tax_depreciation_method,
        status, created_by
      ) VALUES (
        ${assetNumber}, ${body.name}, ${body.description || null},
        ${categoryId}, ${catKey},
        ${(body as any).serialNumber || null}, ${body.location || null},
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

export default withCompany(withErrorHandler(handler as any));
