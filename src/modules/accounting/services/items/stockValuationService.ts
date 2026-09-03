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
 * (the column is nullable) belongs to no tenant and is DISCLOSED — outside the
 * completeness identity, since it is not in this company's universe — rather
 * than silently attributed to the caller.
 *
 * Movements are valued at the cost recorded ON THE MOVEMENT. All 240 production
 * movements are `purchase` with `total_cost` 0.00, so stock has been received
 * and never valued — the report states that rather than presenting R0 as a
 * valuation somebody computed.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

// Every movement_type the CHECK constraint permits is classified here on
// purpose. Nothing is inbound or outbound BY OMISSION: an unclassified movement
// type is the inventory version of an unclassified account, and 'grn' —
// a goods-received note, inbound by any reading — was silently subtracting
// received stock because it was simply missing from the inbound list.

/** Movement types that ADD to quantity on hand. */
export const INBOUND_MOVEMENT_TYPES = [
  'purchase', 'return_in', 'adjustment_in', 'transfer_in', 'grn',
] as const;

/** Movement types that REDUCE quantity on hand. */
export const OUTBOUND_MOVEMENT_TYPES = [
  'sale', 'return_out', 'adjustment_out', 'transfer_out', 'write_off',
] as const;

/**
 * Movement types that are NOT a delta at all. A stocktake 'count' records an
 * absolute quantity observed, so adding it double-counts and subtracting it
 * erases real stock. It is excluded from the arithmetic and named, because
 * silently ignoring it is the same defect in a quieter form.
 */
export const NON_DELTA_MOVEMENT_TYPES = ['count'] as const;

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

export interface StockValuationDisclosure {
  id: string;
  reason: string;
  detail?: string;
  amount?: number;
}

export interface StockValuation {
  rows: StockValuationRow[];
  rowsTotal: number;
  universeTotal: number;
  /**
   * Facts about data this valuation could NOT draw from. NOT exclusions: an
   * exclusion is a row that belongs to the universe and was withheld from the
   * totals, whereas an unattributable movement belongs to no tenant and a
   * stocktake note is a statement about data rather than a row. They are
   * reported outside the envelope's completeness identity for that reason.
   */
  disclosures: StockValuationDisclosure[];
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
  // TWO joins, two deliberately DIFFERENT placements — this reads like the
  // ON-versus-WHERE defect hunted elsewhere in this programme and is the
  // opposite of it:
  //
  //  · `p.company_id` sits in WHERE because the join to products IS the tenant
  //    boundary. In a LEFT JOIN's ON clause it would restrict nothing and
  //    unmatched movements would survive into the SUM.
  //  · `sm.created_at <= asOf` sits in the LEFT JOIN's ON clause, and MUST. In
  //    WHERE it would turn the outer join inner and drop any product whose only
  //    movements fall after the as-of date — a product that should be reported
  //    at zero would vanish from the valuation instead.
  const rows = (await sql`
    SELECT
      p.id, p.code, p.name, p.unit,
      COALESCE(SUM(
        CASE WHEN sm.movement_type = ANY(${INBOUND_MOVEMENT_TYPES as unknown as string[]})
             THEN sm.quantity
             WHEN sm.movement_type = ANY(${OUTBOUND_MOVEMENT_TYPES as unknown as string[]})
             THEN -sm.quantity
             ELSE 0 END
      ), 0) AS quantity_on_hand,
      -- COALESCE per row: total_cost is nullable, and a single NULL would make
      -- the whole product's value NULL rather than 'no cost recorded'.
      COALESCE(SUM(
        CASE WHEN sm.movement_type = ANY(${INBOUND_MOVEMENT_TYPES as unknown as string[]})
             THEN COALESCE(sm.total_cost, 0)
             WHEN sm.movement_type = ANY(${OUTBOUND_MOVEMENT_TYPES as unknown as string[]})
             THEN -COALESCE(sm.total_cost, 0)
             ELSE 0 END
      ), 0) AS value,
      COUNT(sm.id) FILTER (
        WHERE sm.movement_type <> ALL(${NON_DELTA_MOVEMENT_TYPES as unknown as string[]})
      ) AS movement_count,
      COUNT(sm.id) FILTER (
        WHERE sm.movement_type = ANY(${NON_DELTA_MOVEMENT_TYPES as unknown as string[]})
      ) AS non_delta_count,
      MAX(sm.created_at) AS posted_through
    FROM products p
    LEFT JOIN stock_movements sm
           ON sm.product_id = p.id
          AND sm.created_at <= (${asOf}::DATE + INTERVAL '1 day')
    WHERE p.company_id = ${companyId}::UUID
    GROUP BY p.id, p.code, p.name, p.unit
    ORDER BY p.code
  `) as Row[];

  // Movements whose product has no tenant at all. They belong to nobody and are
  // not attributed to the caller. Their EXISTENCE is disclosed; their count and
  // value deliberately are NOT. This query cannot be scoped by company_id —
  // that is the whole point of it — so any figure it produced would be computed
  // from rows that may belong to other tenants, and no label makes that
  // acceptable on a tenant's report. EXISTS, not COUNT.
  const [orphan] = (await sql`
    SELECT EXISTS (
      SELECT 1
      FROM stock_movements sm
      JOIN products p ON p.id = sm.product_id
      WHERE p.company_id IS NULL
    ) AS has_orphans
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
      // A negative quantity means more went out than ever came in — a data
      // fault, not a negative unit cost. Dividing would report a confident
      // negative average; null says "there is no average here".
      averageCost: qty <= 0 ? null : Math.round((value / qty) * 100) / 100,
      movementCount: Number(r.movement_count) || 0,
      unvalued: qty !== 0 && value === 0,
    };
  });

  const disclosures: StockValuationDisclosure[] = [];
  if (orphan?.has_orphans === true) {
    disclosures.push({
      id: 'orphan_movements',
      reason: 'product_has_no_company',
      detail:
        'Stock movements exist against products carrying no company_id. ' +
        'stock_movements has no tenant column of its own, so they cannot be ' +
        'attributed to any company and are not in your figures. Their number ' +
        'and value are withheld deliberately: neither can be scoped to you.',
    });
  }

  const nonDeltaCount = rows.reduce((n, r) => n + (Number(r.non_delta_count) || 0), 0);
  if (nonDeltaCount > 0) {
    disclosures.push({
      id: 'stocktake_counts',
      reason: 'stocktake_count_not_a_delta',
      detail: `${nonDeltaCount} stocktake movements (${NON_DELTA_MOVEMENT_TYPES.join(', ')}) record an absolute quantity observed rather than a change, so they are not summed into quantity on hand.`,
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
    // The universe is THIS COMPANY'S products. The disclosures above are notes
    // about data that is not in it — unattributable movements belong to no
    // tenant, and a stocktake count is not a product — so neither may inflate
    // the count of things this report had to classify.
    universeTotal: mapped.length,
    disclosures,
    totalValue: Math.round(mapped.reduce((s, r) => s + r.value, 0) * 100) / 100,
    totalQuantity: mapped.reduce((s, r) => s + r.quantityOnHand, 0),
    unvaluedProductCount: mapped.filter((r) => r.unvalued).length,
    postedThrough,
  };
}
