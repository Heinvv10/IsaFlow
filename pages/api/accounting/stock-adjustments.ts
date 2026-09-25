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
    //
    // K-086: the row is taken FOR UPDATE because a stocktake is applied
    // against the on-hand it reads. Two concurrent writers must serialise, or
    // a count computes its correction from a figure that has since moved.
    const locked = await sql`
      SELECT current_stock FROM products
      WHERE id = ${body.productId} AND company_id = ${companyId}::UUID
      FOR UPDATE
    ` as Row[];
    if (locked.length === 0) return apiResponse.notFound(res, 'Product', String(body.productId));
    // warehouse_id is written into both documents as given, so it is checked
    // the same way as the product, before the first write (K-086 review).
    if (body.warehouseId) {
      const warehouse = await sql`SELECT id FROM warehouses WHERE id = ${body.warehouseId} AND company_id = ${companyId}::UUID` as Row[];
      if (warehouse.length === 0) return apiResponse.notFound(res, 'Warehouse', String(body.warehouseId));
    }
    const onHand = Number(locked[0]?.current_stock ?? 0);

    // A 'count' is the quantity OBSERVED, not a change: it REPLACES stock on
    // hand, and the movement carries the correction that implies. It used to
    // be signed +1 like an increase, so counting 60 against 100 left 160 and
    // booked a 60-unit adjustment_out. The other types stay deltas, clamp
    // included. Worked in integer cents: validateStockAdjustment admits only
    // exact cents, but a float DIFFERENCE is not exact (100 - 99.95 is
    // 0.04999999999999716), and multiplied by a unit cost it rounds a cent
    // the other way from the same 0.05 booked as a decrease.
    const isCount = body.adjustmentType === 'count';
    const toCents = (n: number) => Math.round(n * 100);
    const deltaCents = isCount
      ? toCents(body.quantity) - toCents(onHand)
      : (body.adjustmentType === 'increase' ? 1 : -1) * toCents(body.quantity);
    const newStock = isCount ? body.quantity : Math.max(0, toCents(onHand) + deltaCents) / 100;

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
    await sql`UPDATE products SET current_stock = ${newStock}, updated_at = NOW() WHERE id = ${body.productId} AND company_id = ${companyId}::UUID`;

    // Record movement. Direction is DERIVED from the delta's sign, never
    // stored beside it, and `quantity` is a positive magnitude, because every
    // reader of stock_movements takes direction from movement_type. A count is
    // NOT booked as movement_type 'count': stockValuationService treats that
    // type as non-delta and leaves it out of quantity on hand, so the
    // correction would never reach the valuation. A count that agrees with
    // the shelf moved nothing and records no movement; the stock_adjustments
    // row above still records that the count happened.
    const magnitude = Math.abs(deltaCents) / 100;
    const movementType = isCount ? (deltaCents > 0 ? 'adjustment_in' : 'adjustment_out')
      : body.adjustmentType === 'increase' ? 'adjustment_in'
      : body.adjustmentType === 'write_off' ? 'write_off' : 'adjustment_out';
    // `stock_movements` has NO company_id column — it never has (244b_inventory.sql
    // creates it without one) and `stockValuationService` documents the model:
    // movements are tenant-scoped by joining `products`. Naming the column here
    // made this INSERT raise 42703 on EVERY adjustment, and `withAuth` rolls a
    // 500 back, so POST /stock-adjustments has never once written a row. Scoped
    // by the ownership check above, which refuses a product of another tenant
    // before anything is written. Adding the column is register item K-085's;
    // this only stops naming a column that does not exist.
    if (deltaCents !== 0) {
      await sql`INSERT INTO stock_movements (product_id, warehouse_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, created_by) VALUES (${body.productId}, ${body.warehouseId || null}, ${movementType}, ${magnitude}, ${body.unitCost || 0}, ${body.unitCost || 0}::NUMERIC * ${magnitude}::NUMERIC, 'stock_adjustment', ${String(inserted[0]?.id)}, ${String(req.user.id)})`;
    }

    log.info('Stock adjusted', { adjNum, type: body.adjustmentType, qty: body.quantity }, 'accounting');
    return apiResponse.created(res, inserted[0]);
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
