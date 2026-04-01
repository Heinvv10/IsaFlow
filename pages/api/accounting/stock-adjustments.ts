/**
 * Stock Adjustments API — increase/decrease/write-off stock
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateStockAdjustment } from '@/modules/accounting/services/inventoryService';
type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const adjustments = await sql`
      SELECT sa.*, p.code as product_code, p.name as product_name
      FROM stock_adjustments sa JOIN products p ON sa.product_id = p.id
      WHERE sa.company_id = ${companyId}::UUID
      ORDER BY sa.created_at DESC LIMIT 200
    ` as Row[];
    return apiResponse.success(res, adjustments);
  }
  if (req.method === 'POST') {
    const body = req.body;
    const validation = validateStockAdjustment(body);
    if (!validation.success) return apiResponse.validationError(res, Object.fromEntries((validation.errors || []).map(e => [e.field, e.message])));

    const countRes = await sql`SELECT COUNT(*) as cnt FROM stock_adjustments WHERE company_id = ${companyId}::UUID` as Row[];
    const adjNum = `ADJ-${String(Number((countRes[0] as any)?.cnt || 0) + 1).padStart(5, '0')}`;

    const inserted = await sql`
      INSERT INTO stock_adjustments (company_id, adjustment_number, product_id, warehouse_id, adjustment_type, quantity, unit_cost, reason, created_by)
      VALUES (${companyId}::UUID, ${adjNum}, ${body.productId}, ${body.warehouseId || null}, ${body.adjustmentType}, ${body.quantity}, ${body.unitCost || 0}, ${body.reason}, ${String(req.user.id)})
      RETURNING *
    ` as Row[];

    // Update product stock (scoped to company via product ownership)
    const sign = ['increase', 'count'].includes(body.adjustmentType) ? 1 : -1;
    await sql`UPDATE products SET current_stock = GREATEST(0, current_stock + ${sign * body.quantity}), updated_at = NOW() WHERE id = ${body.productId} AND company_id = ${companyId}::UUID`;

    // Record movement
    const movementType = body.adjustmentType === 'increase' ? 'adjustment_in' : body.adjustmentType === 'write_off' ? 'write_off' : 'adjustment_out';
    await sql`INSERT INTO stock_movements (company_id, product_id, warehouse_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, created_by) VALUES (${companyId}::UUID, ${body.productId}, ${body.warehouseId || null}, ${movementType}, ${body.quantity}, ${body.unitCost || 0}, ${(body.unitCost || 0) * body.quantity}, 'stock_adjustment', ${String(inserted[0]?.id)}, ${String(req.user.id)})`;

    log.info('Stock adjusted', { adjNum, type: body.adjustmentType, qty: body.quantity }, 'accounting');
    return apiResponse.created(res, inserted[0]);
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}
export default withCompany(withErrorHandler(handler));
