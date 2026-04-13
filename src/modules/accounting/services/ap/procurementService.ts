/**
 * Procurement Service — Purchase Orders, GRN, Three-Way Matching
 * Pure business logic — no database dependencies.
 */

export interface POLineItem {
  productId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
}

export interface PurchaseOrderInput {
  supplierId: string;
  orderDate: string;
  expectedDeliveryDate?: string;
  items: POLineItem[];
  notes?: string;
  reference?: string;
}

export interface GRNLineItem {
  poItemId: string;
  quantityReceived: number;
  quantityRejected: number;
  notes?: string;
}

export interface GRNInput {
  purchaseOrderId: string;
  receivedDate: string;
  receivedBy: string;
  items: GRNLineItem[];
  notes?: string;
}

export interface POTotals {
  subtotal: number;
  taxAmount: number;
  total: number;
  lineCount: number;
}

export interface ThreeWayMatchInput {
  poQuantity: number;
  poUnitPrice: number;
  grnQuantity: number;
  invoiceQuantity: number;
  invoiceUnitPrice: number;
}

export interface ThreeWayMatchResult {
  status: 'fully_matched' | 'quantity_variance' | 'price_variance' | 'variance' | 'over_invoiced' | 'unmatched';
  quantityVariance: number;
  priceVariance: number;
  totalVarianceAmount: number;
}

export interface ValidationResult {
  success: boolean;
  errors?: Array<{ field: string; message: string }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

export function validatePurchaseOrder(input: PurchaseOrderInput): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  if (!input.supplierId || input.supplierId.trim() === '') errors.push({ field: 'supplierId', message: 'Supplier is required' });
  if (!input.items || input.items.length === 0) errors.push({ field: 'items', message: 'At least one line item is required' });
  if (input.orderDate && input.expectedDeliveryDate) {
    if (new Date(input.expectedDeliveryDate) < new Date(input.orderDate)) {
      errors.push({ field: 'expectedDeliveryDate', message: 'Delivery date cannot be before order date' });
    }
  }
  for (let i = 0; i < (input.items || []).length; i++) {
    const item = input.items[i]!;
    if (!item.description || item.description.trim() === '') errors.push({ field: `items[${i}].description`, message: 'Item description is required' });
    if (!item.quantity || item.quantity <= 0) errors.push({ field: `items[${i}].quantity`, message: 'Quantity must be greater than zero' });
    if (item.unitPrice < 0) errors.push({ field: `items[${i}].unitPrice`, message: 'Unit price cannot be negative' });
  }
  return { success: errors.length === 0, ...(errors.length > 0 ? { errors } : {}) };
}

export function validateGRN(input: GRNInput): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  if (!input.purchaseOrderId || input.purchaseOrderId.trim() === '') errors.push({ field: 'purchaseOrderId', message: 'Purchase order reference is required' });
  if (!input.items || input.items.length === 0) errors.push({ field: 'items', message: 'At least one line item is required' });
  for (let i = 0; i < (input.items || []).length; i++) {
    const item = input.items[i]!;
    if (item.quantityReceived < 0) errors.push({ field: `items[${i}].quantityReceived`, message: 'Quantity received cannot be negative' });
    if (item.quantityRejected < 0) errors.push({ field: `items[${i}].quantityRejected`, message: 'Quantity rejected cannot be negative' });
  }
  return { success: errors.length === 0, ...(errors.length > 0 ? { errors } : {}) };
}

// ═══════════════════════════════════════════════════════════════════════════
// PO TOTALS
// ═══════════════════════════════════════════════════════════════════════════

export function calculatePOTotals(items: POLineItem[]): POTotals {
  if (items.length === 0) return { subtotal: 0, taxAmount: 0, total: 0, lineCount: 0 };

  let subtotal = 0;
  let taxAmount = 0;

  for (const item of items) {
    const lineTotal = Math.round(item.quantity * item.unitPrice * 100) / 100;
    const lineTax = Math.round(lineTotal * (item.taxRate / 100) * 100) / 100;
    subtotal += lineTotal;
    taxAmount += lineTax;
  }

  subtotal = Math.round(subtotal * 100) / 100;
  taxAmount = Math.round(taxAmount * 100) / 100;

  return {
    subtotal,
    taxAmount,
    total: Math.round((subtotal + taxAmount) * 100) / 100,
    lineCount: items.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// THREE-WAY MATCHING
// ═══════════════════════════════════════════════════════════════════════════

export function calculateThreeWayMatch(
  input: ThreeWayMatchInput,
  options?: { priceTolerance?: number }
): ThreeWayMatchResult {
  const priceTolerance = options?.priceTolerance ?? 0;

  const quantityVariance = input.grnQuantity - input.poQuantity;
  const priceVariance = input.invoiceUnitPrice - input.poUnitPrice;
  const priceVariancePercent = input.poUnitPrice > 0 ? Math.abs(priceVariance) / input.poUnitPrice : 0;
  const totalVarianceAmount = Math.round(Math.abs(priceVariance) * input.invoiceQuantity * 100) / 100;

  // Check if invoice qty exceeds GRN qty
  if (input.invoiceQuantity > input.grnQuantity) {
    return { status: 'over_invoiced', quantityVariance, priceVariance, totalVarianceAmount };
  }

  const qtyMatch = quantityVariance === 0;
  const priceMatch = priceVariancePercent <= priceTolerance;

  if (qtyMatch && priceMatch) {
    return { status: 'fully_matched', quantityVariance: 0, priceVariance: 0, totalVarianceAmount: 0 };
  }
  if (!qtyMatch && !priceMatch) {
    return { status: 'variance', quantityVariance, priceVariance, totalVarianceAmount };
  }
  if (!qtyMatch) {
    return { status: 'quantity_variance', quantityVariance, priceVariance: 0, totalVarianceAmount: 0 };
  }
  return { status: 'price_variance', quantityVariance: 0, priceVariance, totalVarianceAmount };
}

// ═══════════════════════════════════════════════════════════════════════════
// NUMBER GENERATION
// ═══════════════════════════════════════════════════════════════════════════

export function generatePONumber(existingCount: number): string {
  return `PO-${String(existingCount + 1).padStart(5, '0')}`;
}

export function generateGRNNumber(existingCount: number): string {
  return `GRN-${String(existingCount + 1).padStart(5, '0')}`;
}
