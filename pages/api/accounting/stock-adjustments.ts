/**
 * Stock Adjustments API — increase/decrease/write-off stock
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateStockAdjustment } from '@/modules/accounting/services/items/inventoryService';
import { insertWithReservedNumber } from '@/modules/accounting/services/core/documentNumberRetry';
type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

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

    // The product ownership check runs BEFORE the first write. It used to sit
    // after the adjustment INSERT, so a product belonging to another tenant
    // answered 404 — and `withAuth` COMMITs anything below 500, leaving the
    // stock_adjustment row (and its number) behind for a movement that never
    // happened.
    const sign = ['increase', 'count'].includes(body.adjustmentType) ? 1 : -1;
    const owned = await sql`SELECT id FROM products WHERE id = ${body.productId} AND company_id = ${companyId}::UUID` as Row[];
    if (owned.length === 0) return apiResponse.notFound(res, 'Product', String(body.productId));

    // `ADJ-${COUNT(*)+1}` is not a sequence: it repeats after any deletion and
    // two concurrent adjustments compute the same count. `stock_adjustments`
    // had no unique index either, so the duplicate was silent — two documents
    // moving inventory value under one number. The number now comes from the
    // company's atomic `stock_adjustment` counter, and migration 671 makes a
    // clash with a legacy `ADJ-nnnnn` row fail rather than duplicate.
    const inserted = await insertWithReservedNumber(
      companyId, 'stock_adjustment', 'stock_adj_', 'uq_stock_adjustments_company_number',
      async (adjNum) => await sql`
        INSERT INTO stock_adjustments (company_id, adjustment_number, product_id, warehouse_id, adjustment_type, quantity, unit_cost, reason, created_by)
        VALUES (${companyId}::UUID, ${adjNum}, ${body.productId}, ${body.warehouseId || null}, ${body.adjustmentType}, ${body.quantity}, ${body.unitCost || 0}, ${body.reason}, ${String(req.user.id)})
        RETURNING *
      ` as Row[],
    );
    const adjNum = String(inserted[0]?.adjustment_number);

    // Update product stock (scoped to company via product ownership)
    await sql`UPDATE products SET current_stock = GREATEST(0, current_stock + ${sign * body.quantity}), updated_at = NOW() WHERE id = ${body.productId} AND company_id = ${companyId}::UUID`;

    // Record movement
    const movementType = body.adjustmentType === 'increase' ? 'adjustment_in' : body.adjustmentType === 'write_off' ? 'write_off' : 'adjustment_out';
    // `stock_movements` has NO company_id column — it never has (244b_inventory.sql
    // creates it without one) and `stockValuationService` documents the model:
    // movements are tenant-scoped by joining `products`. Naming the column here
    // made this INSERT raise 42703 on EVERY adjustment, and `withAuth` rolls a
    // 500 back, so POST /stock-adjustments has never once written a row. Scoped
    // by the ownership check above, which refuses a product of another tenant
    // before anything is written. Adding the column is register item K-085's;
    // this only stops naming a column that does not exist.
    await sql`INSERT INTO stock_movements (product_id, warehouse_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, created_by) VALUES (${body.productId}, ${body.warehouseId || null}, ${movementType}, ${body.quantity}, ${body.unitCost || 0}, ${(body.unitCost || 0) * body.quantity}, 'stock_adjustment', ${String(inserted[0]?.id)}, ${String(req.user.id)})`;

    log.info('Stock adjusted', { adjNum, type: body.adjustmentType, qty: body.quantity }, 'accounting');
    return apiResponse.created(res, inserted[0]);
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
