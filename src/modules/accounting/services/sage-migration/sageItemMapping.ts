/**
 * Sage item -> the argument rows of upsert_item_category and bulk_upsert_items. PURE.
 *
 *   Sage                                   IsaFlow row field
 *   ID                                     external_ref (external_system "sage")
 *   Code / Description                     code / description
 *   Physical false                         item_type "service" (physical true: "physical")
 *   (always)                               inventory_tracked false (Phase C is off; a service can never be tracked)
 *   Active                                 is_active
 *   PriceExclusive                         sales_price
 *   LastCost, else AverageCost             purchase_price (rounded to whole cents; a 0 LastCost falls back to AverageCost)
 *   TaxTypeIdSales / TaxTypeIdPurchases    vat_on_sales / vat_on_purchases (sageTaxTypes)
 *   Category.Description                   category_name (the category is created first, with Category.ID as its external_ref)
 *   QuantityOnHand                         NOTHING. Never imported, never an opening stock row (hard rule).
 */
import type { SageCategory, SageItem } from './sageExportTypes';

export const SAGE_SYSTEM = 'sage';

export function mapSageCategory(c: SageCategory): Record<string, unknown> {
  return { name: c.description, external_system: SAGE_SYSTEM, external_ref: c.id, is_active: true };
}

export function mapSageItem(item: SageItem): Record<string, unknown> {
  const cost = item.lastCost !== null && item.lastCost > 0 ? item.lastCost : item.averageCost ?? item.lastCost;
  return {
    code: item.code,
    description: item.description,
    item_type: item.physical ? 'physical' : 'service',
    inventory_tracked: false,
    is_active: item.active,
    external_system: SAGE_SYSTEM,
    external_ref: item.id,
    ...(item.category ? { category_name: item.category.description } : {}),
    ...(item.priceExclusive !== null ? { sales_price: item.priceExclusive } : {}),
    ...(cost !== null ? { purchase_price: cost } : {}),
    ...(item.taxSales ? { vat_on_sales: item.taxSales } : {}),
    ...(item.taxPurchases ? { vat_on_purchases: item.taxPurchases } : {}),
  };
}
