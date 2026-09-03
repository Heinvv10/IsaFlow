/**
 * Stock on hand and what it is worth.
 *
 * THREE PARALLEL INVENTORY MODELS LIVE IN THIS SCHEMA, and only one of them
 * holds data. `items` (0 rows) and `stock_items` (0 rows) each carry their own
 * `company_id`; `products` (6 rows) with `stock_movements` (240 rows) is the one
 * that is actually used. This service reads the third, and says so, because a
 * valuation built on either of the empty two would confidently return zero.
 *
 * `stock_movements` and `stock_levels` HAVE NO `company_id` COLUMN. They are
 * tenant-scopable only by joining `products`, which is what every query here
 * does — the join is the tenant boundary, so it is an INNER join and the
 * predicate lives in WHERE. A row whose product carries a NULL `company_id`
 * (the column is nullable) belongs to no tenant and is reported as excluded
 * rather than silently attributed to the caller.
 *
 * Movements are valued at the cost recorded ON THE MOVEMENT. All 240 production
 * movements are `purchase` with `total_cost` 0.00, so stock has been received
 * and never valued — the report states that rather than presenting R0 as a
 * valuation somebody computed.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

/** Movement types that ADD to quantity on hand. Everything else reduces it. */
export const INBOUND_MOVEMENT_TYPES = ['purchase', 'return_in', 'adjustment_in', 'transfer_in'] as const;

export interface StockValuationRow {
  productId: string;
  code: string;
  name: string;
  unit: string;
  quantityOnHand: number;
  /** Sum of movement total_cost, inbound positive and outbound negative. */
  value: number;
  /** value / quantityOnHand, or null when there is no quantity to divide by. */
  averageCost: number | null;
  movementCount: number;
  /** True when the product has quantity but no cost was ever recorded against it. */
  unvalued: boolean;
}

export interface StockValuationExclusion {
  id: string;
  reason: string;
  detail?: string;
  amount?: number;
}

export interface StockValuation {
  rows: StockValuationRow[];
  rowsTotal: number;
  universeTotal: number;
  excluded: StockValuationExclusion[];
  totalValue: number;
  totalQuantity: number;
  /** Products carrying quantity against which no cost was ever recorded. */
  unvaluedProductCount: number;
  postedThrough: string | null;
}

export async function getStockValuation(
  companyId: string,
  asOf: string,
): Promise<StockValuation> {
  // The tenant boundary is the join to products, so it is INNER and the
  // company predicate sits in WHERE. In a LEFT JOIN's ON clause it would
  // restrict nothing and unmatched movements would survive into the SUM.
  const rows = (await sql`
    SELECT
      p.id, p.code, p.name, p.unit,
      COALESCE(SUM(
        CASE WHEN sm.movement_type = ANY(${INBOUND_MOVEMENT_TYPES as unknown as string[]})
             THEN sm.quantity ELSE -sm.quantity END
      ), 0) AS quantity_on_hand,
      COALESCE(SUM(
        CASE WHEN sm.movement_type = ANY(${INBOUND_MOVEMENT_TYPES as unknown as string[]})
             THEN sm.total_cost ELSE -sm.total_cost END
      ), 0) AS value,
      COUNT(sm.id) AS movement_count,
      MAX(sm.created_at) AS posted_through
    FROM products p
    LEFT JOIN stock_movements sm
           ON sm.product_id = p.id
          AND sm.created_at <= (${asOf}::DATE + INTERVAL '1 day')
    WHERE p.company_id = ${companyId}::UUID
    GROUP BY p.id, p.code, p.name, p.unit
    ORDER BY p.code
  `) as Row[];

  // Movements whose product has no tenant at all. They belong to nobody and
  // must not be attributed to the caller — but a silent drop is the defect, so
  // they are counted and named.
  const [orphan] = (await sql`
    SELECT COUNT(*) AS orphan_movements,
           COALESCE(SUM(sm.total_cost), 0) AS orphan_value
    FROM stock_movements sm
    JOIN products p ON p.id = sm.product_id
    WHERE p.company_id IS NULL
  `) as Row[];

  const mapped: StockValuationRow[] = rows.map((r) => {
    const qty = Number(r.quantity_on_hand) || 0;
    const value = Number(r.value) || 0;
    return {
      productId: String(r.id),
      code: String(r.code ?? ''),
      name: String(r.name ?? ''),
      unit: String(r.unit ?? ''),
      quantityOnHand: qty,
      value,
      averageCost: qty === 0 ? null : Math.round((value / qty) * 100) / 100,
      movementCount: Number(r.movement_count) || 0,
      unvalued: qty !== 0 && value === 0,
    };
  });

  const excluded: StockValuationExclusion[] = [];
  const orphanCount = Number(orphan?.orphan_movements ?? 0);
  if (orphanCount > 0) {
    excluded.push({
      id: 'orphan_movements',
      reason: 'product_has_no_company',
      detail: `${orphanCount} stock movements belong to products with no company_id. stock_movements has no tenant column of its own, so these cannot be attributed to any company.`,
      amount: Number(orphan?.orphan_value ?? 0),
    });
  }

  const postedThrough = rows
    .map((r) => (r.posted_through ? new Date(String(r.posted_through)).toISOString() : null))
    .filter((v): v is string => v !== null)
    .sort()
    .slice(-1)[0] ?? null;

  return {
    rows: mapped,
    rowsTotal: mapped.length,
    universeTotal: mapped.length + excluded.length,
    excluded,
    totalValue: Math.round(mapped.reduce((s, r) => s + r.value, 0) * 100) / 100,
    totalQuantity: mapped.reduce((s, r) => s + r.quantityOnHand, 0),
    unvaluedProductCount: mapped.filter((r) => r.unvalued).length,
    postedThrough,
  };
}
