/**
 * Inventory Service — Products, Stock, and Valuation
 * Pure business logic — no database dependencies (testable without DB).
 */

export type ProductType = 'inventory' | 'non_inventory' | 'service';
export type CostMethod = 'weighted_average' | 'fifo';
export type AdjustmentType = 'increase' | 'decrease' | 'write_off' | 'transfer' | 'count';

export interface ProductInput {
  name: string;
  code: string;
  category: string;
  type: ProductType | string;
  unit: string;
  costPrice: number;
  sellingPrice: number;
  reorderLevel: number;
  reorderQuantity?: number;
  costMethod: CostMethod | string;
  description?: string;
  barcode?: string;
  taxRate?: number;
}

export interface StockAdjustmentInput {
  productId: string;
  adjustmentType: AdjustmentType | string;
  quantity: number;
  reason: string;
  unitCost?: number;
  warehouseId?: string;
}

export interface StockMovement {
  type: 'purchase' | 'sale' | 'adjustment';
  qty: number;
  unitCost: number;
  date: string;
}

export interface ValuationResult {
  totalValue: number;
  avgCost: number;
  totalQty: number;
}

export interface ValidationResult {
  success: boolean;
  errors?: Array<{ field: string; message: string }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// WEIGHTED AVERAGE COST
// ═══════════════════════════════════════════════════════════════════════════

export function calculateWeightedAverage(input: {
  currentQty: number;
  currentAvgCost: number;
  newQty: number;
  newUnitCost: number;
}): ValuationResult {
  const { currentQty, currentAvgCost, newQty, newUnitCost } = input;
  const totalQty = currentQty + newQty;
  if (totalQty <= 0) return { totalValue: 0, avgCost: 0, totalQty: 0 };
  const totalValue = currentQty * currentAvgCost + newQty * newUnitCost;
  const avgCost = Math.round((totalValue / totalQty) * 100) / 100;
  return { totalValue: Math.round(totalValue * 100) / 100, avgCost, totalQty };
}

// ═══════════════════════════════════════════════════════════════════════════
// FIFO VALUATION
// ═══════════════════════════════════════════════════════════════════════════

export function calculateFIFO(movements: StockMovement[], currentQty: number): ValuationResult {
  if (movements.length === 0 || currentQty <= 0) {
    return { totalValue: 0, avgCost: 0, totalQty: 0 };
  }

  // Build purchase batches in order
  const batches: Array<{ qty: number; unitCost: number }> = [];

  for (const m of movements) {
    if (m.type === 'purchase' || (m.type === 'adjustment' && m.qty > 0)) {
      batches.push({ qty: m.qty, unitCost: m.unitCost });
    } else if (m.type === 'sale' || (m.type === 'adjustment' && m.qty < 0)) {
      let remaining = Math.abs(m.qty);
      for (const batch of batches) {
        if (remaining <= 0) break;
        const consume = Math.min(batch.qty, remaining);
        batch.qty -= consume;
        remaining -= consume;
      }
    }
  }

  // Value remaining stock from oldest batches
  let remaining = currentQty;
  let totalValue = 0;

  for (const batch of batches) {
    if (remaining <= 0 || batch.qty <= 0) continue;
    const use = Math.min(batch.qty, remaining);
    totalValue += use * batch.unitCost;
    remaining -= use;
  }

  totalValue = Math.round(totalValue * 100) / 100;
  const avgCost = currentQty > 0 ? Math.round((totalValue / currentQty) * 100) / 100 : 0;

  return { totalValue, avgCost, totalQty: currentQty };
}

// ═══════════════════════════════════════════════════════════════════════════
// STOCK VALUE
// ═══════════════════════════════════════════════════════════════════════════

export function calculateStockValue(quantity: number, unitCost: number): number {
  return Math.round(quantity * unitCost * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCT CODE GENERATION
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORY_PREFIXES: Record<string, string> = {
  widgets: 'WDG',
  raw_materials: 'RAW',
  finished_goods: 'FIN',
  consumables: 'CON',
  electronics: 'ELC',
  packaging: 'PKG',
  spare_parts: 'SPR',
  services: 'SVC',
  stationery: 'STN',
};

export function generateProductCode(category: string, existingCount: number): string {
  const prefix = CATEGORY_PREFIXES[category] || 'PRD';
  return `${prefix}-${String(existingCount + 1).padStart(4, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

const VALID_TYPES: ProductType[] = ['inventory', 'non_inventory', 'service'];
const VALID_COST_METHODS: CostMethod[] = ['weighted_average', 'fifo'];
const VALID_ADJUSTMENT_TYPES: AdjustmentType[] = ['increase', 'decrease', 'write_off', 'transfer', 'count'];

export function validateProduct(input: ProductInput): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  if (!input.name || input.name.trim() === '') errors.push({ field: 'name', message: 'Product name is required' });
  if (!input.code || input.code.trim() === '') errors.push({ field: 'code', message: 'Product code is required' });
  if (input.costPrice < 0) errors.push({ field: 'costPrice', message: 'Cost price cannot be negative' });
  if (input.sellingPrice < 0) errors.push({ field: 'sellingPrice', message: 'Selling price cannot be negative' });
  if (input.reorderLevel < 0) errors.push({ field: 'reorderLevel', message: 'Reorder level cannot be negative' });
  if (input.type && !VALID_TYPES.includes(input.type as ProductType)) errors.push({ field: 'type', message: 'Invalid product type' });
  if (input.costMethod && !VALID_COST_METHODS.includes(input.costMethod as CostMethod)) errors.push({ field: 'costMethod', message: 'Invalid cost method' });
  return { success: errors.length === 0, ...(errors.length > 0 ? { errors } : {}) };
}

/**
 * A finite number that is EXACTLY some whole number of cents. Number.isFinite
 * does not coerce, so a string ("NaN", "60") is refused. The equality is
 * exact, not a tolerance: 100.000000001 is refused, where a 1e-6 tolerance let
 * it through to a 0.00 movement. Every 2-decimal literal JSON can carry
 * round-trips through Math.round(x * 100) / 100 unchanged.
 */
function isTwoDecimalAmount(x: unknown): x is number {
  return Number.isFinite(x) && Math.round((x as number) * 100) / 100 === x;
}

export function validateStockAdjustment(input: StockAdjustmentInput): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  if (!input.productId || input.productId.trim() === '') errors.push({ field: 'productId', message: 'Product ID is required' });
  if (!input.quantity || input.quantity <= 0) errors.push({ field: 'quantity', message: 'Quantity must be greater than zero' });
  // Quantities are NUMERIC(15,2) (K-086). A third decimal is rounded one way
  // by JS arithmetic and another by Postgres, splitting the adjustment
  // document from the stock it set. A string must not pass either: "NaN"
  // is truthy, is not <= 0, and NUMERIC stores NaN (which Postgres ranks
  // above 0, so CHECK (quantity > 0) admits it) — it would poison stock.
  else if (!isTwoDecimalAmount(input.quantity)) {
    errors.push({ field: 'quantity', message: 'Quantity must be a number with at most 2 decimals' });
  }
  if (!input.reason || input.reason.trim() === '') errors.push({ field: 'reason', message: 'Reason is required' });
  if (input.adjustmentType && !VALID_ADJUSTMENT_TYPES.includes(input.adjustmentType as AdjustmentType)) errors.push({ field: 'adjustmentType', message: 'Invalid adjustment type' });
  if (input.adjustmentType === 'increase' && (input.unitCost === undefined || input.unitCost === null)) errors.push({ field: 'unitCost', message: 'Unit cost is required for stock increases' });
  // A stocktake's correction is what moves the valuation, which is costed
  // on the movement: without a cost, shrinkage would leave at R0 and its
  // value would stay on the books (K-086).
  else if (input.adjustmentType === 'count' && (input.unitCost === undefined || input.unitCost === null)) errors.push({ field: 'unitCost', message: 'Unit cost is required for a stock count' });
  else if (input.unitCost !== undefined && input.unitCost !== null
    && (!isTwoDecimalAmount(input.unitCost) || input.unitCost < 0)) {
    errors.push({ field: 'unitCost', message: 'Unit cost must be a number of zero or more with at most 2 decimals' });
  }
  return { success: errors.length === 0, ...(errors.length > 0 ? { errors } : {}) };
}
