/**
 * Products API — CRUD for inventory items
 * GET: list products, POST: create product
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateProduct, generateProductCode, type ProductInput } from '@/modules/accounting/services/inventoryService';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const { search, category, type, active } = req.query;
    let rows: Row[];
    if (search) {
      const term = `%${String(search)}%`;
      rows = await sql`SELECT p.*, pc.name as category_name FROM products p LEFT JOIN product_categories pc ON p.category_id = pc.id WHERE p.company_id = ${companyId}::UUID AND (p.name ILIKE ${term} OR p.code ILIKE ${term} OR p.barcode ILIKE ${term}) ORDER BY p.name LIMIT 200` as Row[];
    } else if (category) {
      rows = await sql`SELECT p.*, pc.name as category_name FROM products p LEFT JOIN product_categories pc ON p.category_id = pc.id WHERE p.company_id = ${companyId}::UUID AND (p.category = ${String(category)} OR pc.code = ${String(category)}) ORDER BY p.name LIMIT 200` as Row[];
    } else if (type) {
      rows = await sql`SELECT p.*, pc.name as category_name FROM products p LEFT JOIN product_categories pc ON p.category_id = pc.id WHERE p.company_id = ${companyId}::UUID AND p.product_type = ${String(type)} ORDER BY p.name LIMIT 200` as Row[];
    } else {
      rows = await sql`SELECT p.*, pc.name as category_name FROM products p LEFT JOIN product_categories pc ON p.category_id = pc.id WHERE p.company_id = ${companyId}::UUID AND p.is_active = true ORDER BY p.name LIMIT 200` as Row[];
    }
    return apiResponse.success(res, rows);
  }
  if (req.method === 'POST') {
    const body = req.body as ProductInput;
    const validation = validateProduct(body);
    if (!validation.success) return apiResponse.validationError(res, Object.fromEntries((validation.errors || []).map(e => [e.field, e.message])));
    let categoryId: string | null = null;
    if (body.category) {
      const cats = await sql`SELECT id FROM product_categories WHERE code = ${body.category} AND company_id = ${companyId}::UUID LIMIT 1` as Row[];
      if (cats[0]) categoryId = String(cats[0].id);
    }
    const code = body.code || generateProductCode(body.category || 'general', 0);
    const inserted = await sql`
      INSERT INTO products (company_id, code, name, description, category_id, category, barcode, unit, product_type, cost_price, selling_price, cost_method, tax_rate, reorder_level, reorder_quantity, created_by)
      VALUES (${companyId}::UUID, ${code}, ${body.name}, ${body.description || null}, ${categoryId}, ${body.category || null}, ${body.barcode || null}, ${body.unit || 'each'}, ${body.type || 'inventory'}, ${body.costPrice || 0}, ${body.sellingPrice || 0}, ${body.costMethod || 'weighted_average'}, ${body.taxRate || 15}, ${body.reorderLevel || 0}, ${body.reorderQuantity || 0}, ${String(req.user.id)})
      RETURNING *
    ` as Row[];
    log.info('Product created', { code, name: body.name }, 'accounting');
    return apiResponse.created(res, inserted[0]);
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}
export default withCompany(withErrorHandler(handler as any));
