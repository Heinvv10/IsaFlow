/**
 * Fixed-asset registration: the `assets` INSERT and the number it mints.
 *
 * Extracted VERBATIM from `POST /api/accounting/assets` so the route and the MCP `create_fixed_asset` tool run ONE
 * implementation. It registers the asset on the subledger and posts NOTHING to the ledger: no capitalisation
 * journal, no dimension and no bill link. The cost account (`glAssetAccountId`, optional) is stored as given: the
 * caller checks it first with `assetCostAccountProblem`, the gate `PATCH .../gl-account` applies. Callers validate
 * with `assetService.validateAsset` first.
 *
 * Plan, then insert: `planAssetCreate` resolves the category and mints the number under the category's number lock
 * (mig 864) and writes nothing, so a dry run is the live path minus the INSERT.
 */
import { sql } from '@/lib/neon';
import { ASSET_NUMBER_SEED, takeCompanyNumberLock } from '../core/numberLock';
import { validateAssetCostAccount } from '../gl/leafAccountValidator';
import { assetNumberPrefix, generateAssetNumber, type AssetInput } from './assetService';

type Row = Record<string, unknown>;

export interface AssetCreatePlan {
  categoryId: string | null;
  sarsRate: number | null;
  taxLife: number | null;
  /** The `assets.category` text: the category code, or `general` when none was given. */
  categoryKey: string;
  assetNumber: string;
}

export interface AssetCategoryOption {
  code: string;
  name: string;
  sarsYears: number;
}

/** The categories an asset can be filed under (`asset_categories` is global, not per company). */
export async function listActiveAssetCategories(): Promise<AssetCategoryOption[]> {
  const rows = (await sql`
    SELECT code, name, sars_years FROM asset_categories WHERE is_active = true ORDER BY code
  `) as Row[];
  return rows.map((r) => ({ code: String(r.code), name: String(r.name), sarsYears: Number(r.sars_years) }));
}

/**
 * Why `accountId` cannot be the asset's cost account, or null when it can: the gate `PATCH .../gl-account` applies
 * (this company's, active, leaf, fixed-asset-cost subtype), so a created asset can later be disposed. A foreign and a
 * missing id read the same ('Account not found'). Call before any write.
 */
export async function assetCostAccountProblem(companyId: string, accountId: string): Promise<string | null> {
  const check = await validateAssetCostAccount(accountId, companyId);
  return check.ok ? null : check.reason;
}

/** Resolves the category and mints the next number. Takes the category's number lock; writes no asset row. */
export async function planAssetCreate(companyId: string, body: AssetInput): Promise<AssetCreatePlan> {
  let categoryId: string | null = null;
  let sarsRate: number | null = null;
  let taxLife: number | null = null;

  if (body.sarsCategory || body.category) {
    const catCode = body.sarsCategory || body.category;
    const cats = (await sql`
      SELECT id, sars_rate, sars_years FROM asset_categories WHERE code = ${catCode} LIMIT 1
    `) as Row[];
    if (cats[0]) {
      categoryId = String(cats[0].id);
      sarsRate = Number(cats[0].sars_rate);
      taxLife = Number(cats[0].sars_years);
    }
  }

  const categoryKey = body.category || body.sarsCategory || 'general';
  // MAX of the numbers ALREADY MINTED under this category's prefix, not a
  // COUNT of the category's rows: assets carries UNIQUE(company_id,
  // asset_number), and count is not max — after a single asset was deleted
  // every later create in that category re-issued an existing number and
  // 23505'd permanently, since the count never caught up.
  // Under the category's number lock (migration 864), taken before the MAX:
  // a concurrent create in the same category waits for this one to commit
  // and mints the next number, instead of reading the same MAX and failing
  // 23505. Held past 5 s -> 55P03 -> 503 + Retry-After (withErrorHandler).
  const assetPrefix = assetNumberPrefix(body.sarsCategory || body.category || 'general');
  await takeCompanyNumberLock(companyId, assetPrefix, ASSET_NUMBER_SEED);
  const maxResult = (await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(asset_number FROM '[0-9]+$') AS INTEGER)), 0) AS max_num
    FROM assets
    WHERE company_id = ${companyId}::UUID AND asset_number LIKE ${assetPrefix + '-%'}
  `) as Row[];
  const assetNumber = generateAssetNumber(
    body.sarsCategory || body.category || 'general',
    Number(maxResult[0]?.max_num ?? 0),
  );
  return { categoryId, sarsRate, taxLife, categoryKey, assetNumber };
}

/** INSERTs the planned asset and returns the row. */
export async function insertPlannedAsset(
  companyId: string,
  userId: string,
  body: AssetInput,
  plan: AssetCreatePlan,
): Promise<Row> {
  const inserted = (await sql`
    INSERT INTO assets (
      company_id, asset_number, name, description, category_id, category,
      serial_number, location, purchase_date, purchase_price,
      salvage_value, useful_life_years, depreciation_method,
      sars_category, sars_rate, tax_useful_life_years, tax_depreciation_method,
      status, created_by, gl_asset_account_id
    ) VALUES (
      ${companyId}::UUID, ${plan.assetNumber}, ${body.name}, ${body.description || null},
      ${plan.categoryId}, ${plan.categoryKey},
      ${body.serialNumber || null}, ${body.location || null},
      ${body.purchaseDate}, ${body.cost},
      ${body.salvageValue || 0}, ${body.usefulLifeYears}, ${body.depreciationMethod || 'straight_line'},
      ${body.sarsCategory || null}, ${plan.sarsRate}, ${plan.taxLife}, ${'straight_line'},
      ${body.status || 'available'}, ${userId}, ${body.glAssetAccountId || null}::UUID
    ) RETURNING *
  `) as Row[];
  return inserted[0] as Row;
}

/** Plan + insert: the REST route's entry point. */
export async function createAsset(companyId: string, userId: string, body: AssetInput): Promise<Row> {
  const plan = await planAssetCreate(companyId, body);
  return insertPlannedAsset(companyId, userId, body, plan);
}

/**
 * Assets of this company with the same name, purchase date and cost. Nothing in `assets` is unique on those and no
 * path deletes an asset, so the MCP tool reports them (it does not refuse: five identical laptops bought on one day
 * are legitimate) before a second identical row is made.
 */
export async function findSimilarAssets(
  companyId: string,
  name: string,
  purchaseDate: string,
  cost: number,
): Promise<Array<{ id: string; assetNumber: string; name: string }>> {
  const rows = (await sql`
    SELECT id, asset_number, name FROM assets
    WHERE company_id = ${companyId}::UUID AND lower(name) = lower(${name})
      AND purchase_date = ${purchaseDate}::DATE AND purchase_price = ${cost}
    ORDER BY asset_number LIMIT 5
  `) as Row[];
  return rows.map((r) => ({ id: String(r.id), assetNumber: String(r.asset_number), name: String(r.name) }));
}
