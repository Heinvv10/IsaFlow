/**
 * Stock Levels API — current stock per product
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const companyId = (req as any).companyId as string;
  const { belowReorder } = req.query;
  let rows: Row[];
  if (belowReorder === 'true') {
    rows = await sql`SELECT p.id, p.code, p.name, p.current_stock, p.reorder_level, p.reorder_quantity, p.avg_cost, p.selling_price, p.unit, p.category FROM products p WHERE p.is_active = true AND p.product_type = 'inventory' AND p.current_stock <= p.reorder_level AND p.company_id = ${companyId}::UUID ORDER BY p.current_stock ASC` as Row[];
  } else {
    rows = await sql`SELECT p.id, p.code, p.name, p.current_stock, p.reorder_level, p.reorder_quantity, p.avg_cost, p.selling_price, p.unit, p.category, (p.current_stock * p.avg_cost) as stock_value FROM products p WHERE p.is_active = true AND p.product_type = 'inventory' AND p.company_id = ${companyId}::UUID ORDER BY p.name` as Row[];
  }
  const summary = {
    totalProducts: rows.length,
    totalStockValue: rows.reduce((s, r) => s + Number(r.stock_value || 0), 0),
    belowReorder: rows.filter(r => Number(r.current_stock) <= Number(r.reorder_level)).length,
  };
  return apiResponse.success(res, { items: rows, summary });
}
export default withCompany(withErrorHandler(handler as any));
