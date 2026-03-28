/**
 * TDD: Purchase Orders & GRN Business Logic Tests
 * Written BEFORE implementation — RED phase.
 */

import { describe, it, expect } from 'vitest';
import {
  validatePurchaseOrder,
  validateGRN,
  calculatePOTotals,
  calculateThreeWayMatch,
  generatePONumber,
  generateGRNNumber,
  type PurchaseOrderInput,
  type POLineItem,
  type GRNInput,
  type GRNLineItem,
  type ThreeWayMatchResult,
} from '@/modules/accounting/services/procurementService';

// ═══════════════════════════════════════════════════════════════════════════
// PURCHASE ORDER VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Purchase Order Validation', () => {
  const validPO: PurchaseOrderInput = {
    supplierId: '123e4567-e89b-12d3-a456-426614174000',
    orderDate: '2026-03-15',
    expectedDeliveryDate: '2026-04-15',
    items: [
      { productId: 'prod-001', description: 'Widget A', quantity: 100, unitPrice: 50, taxRate: 15 },
    ],
  };

  it('accepts valid purchase order', () => {
    expect(validatePurchaseOrder(validPO).success).toBe(true);
  });

  it('rejects missing supplier', () => {
    expect(validatePurchaseOrder({ ...validPO, supplierId: '' }).success).toBe(false);
  });

  it('rejects empty items', () => {
    expect(validatePurchaseOrder({ ...validPO, items: [] }).success).toBe(false);
  });

  it('rejects item with zero quantity', () => {
    const po = { ...validPO, items: [{ ...validPO.items[0]!, quantity: 0 }] };
    expect(validatePurchaseOrder(po).success).toBe(false);
  });

  it('rejects item with negative quantity', () => {
    const po = { ...validPO, items: [{ ...validPO.items[0]!, quantity: -5 }] };
    expect(validatePurchaseOrder(po).success).toBe(false);
  });

  it('rejects item with negative unit price', () => {
    const po = { ...validPO, items: [{ ...validPO.items[0]!, unitPrice: -10 }] };
    expect(validatePurchaseOrder(po).success).toBe(false);
  });

  it('rejects delivery date before order date', () => {
    expect(validatePurchaseOrder({
      ...validPO,
      orderDate: '2026-04-15',
      expectedDeliveryDate: '2026-03-15',
    }).success).toBe(false);
  });

  it('accepts multiple line items', () => {
    const po = {
      ...validPO,
      items: [
        { productId: 'p1', description: 'Item 1', quantity: 10, unitPrice: 100, taxRate: 15 },
        { productId: 'p2', description: 'Item 2', quantity: 20, unitPrice: 50, taxRate: 15 },
      ],
    };
    expect(validatePurchaseOrder(po).success).toBe(true);
  });

  it('rejects item with missing description', () => {
    const po = { ...validPO, items: [{ ...validPO.items[0]!, description: '' }] };
    expect(validatePurchaseOrder(po).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PO TOTALS CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

describe('PO Totals Calculation', () => {
  it('calculates subtotal correctly', () => {
    const items: POLineItem[] = [
      { productId: 'p1', description: 'A', quantity: 10, unitPrice: 100, taxRate: 15 },
      { productId: 'p2', description: 'B', quantity: 5, unitPrice: 200, taxRate: 15 },
    ];
    const result = calculatePOTotals(items);
    // 10*100 + 5*200 = 2000
    expect(result.subtotal).toBe(2000);
  });

  it('calculates VAT at 15%', () => {
    const items: POLineItem[] = [
      { productId: 'p1', description: 'A', quantity: 10, unitPrice: 100, taxRate: 15 },
    ];
    const result = calculatePOTotals(items);
    expect(result.taxAmount).toBe(150); // 1000 * 15%
  });

  it('calculates total including VAT', () => {
    const items: POLineItem[] = [
      { productId: 'p1', description: 'A', quantity: 10, unitPrice: 100, taxRate: 15 },
    ];
    const result = calculatePOTotals(items);
    expect(result.total).toBe(1150); // 1000 + 150
  });

  it('handles mixed tax rates', () => {
    const items: POLineItem[] = [
      { productId: 'p1', description: 'Standard', quantity: 10, unitPrice: 100, taxRate: 15 },
      { productId: 'p2', description: 'Zero-rated', quantity: 5, unitPrice: 100, taxRate: 0 },
    ];
    const result = calculatePOTotals(items);
    expect(result.subtotal).toBe(1500);
    expect(result.taxAmount).toBe(150); // Only on first item
    expect(result.total).toBe(1650);
  });

  it('handles empty items', () => {
    const result = calculatePOTotals([]);
    expect(result.subtotal).toBe(0);
    expect(result.taxAmount).toBe(0);
    expect(result.total).toBe(0);
  });

  it('rounds to 2 decimal places', () => {
    const items: POLineItem[] = [
      { productId: 'p1', description: 'A', quantity: 3, unitPrice: 10.33, taxRate: 15 },
    ];
    const result = calculatePOTotals(items);
    expect(result.subtotal).toBe(30.99);
    expect(result.taxAmount).toBeCloseTo(4.65, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GRN VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('GRN Validation', () => {
  const validGRN: GRNInput = {
    purchaseOrderId: 'po-001',
    receivedDate: '2026-04-01',
    receivedBy: 'John Doe',
    items: [
      { poItemId: 'poi-001', quantityReceived: 100, quantityRejected: 0, notes: '' },
    ],
  };

  it('accepts valid GRN', () => {
    expect(validateGRN(validGRN).success).toBe(true);
  });

  it('rejects missing PO reference', () => {
    expect(validateGRN({ ...validGRN, purchaseOrderId: '' }).success).toBe(false);
  });

  it('rejects empty items', () => {
    expect(validateGRN({ ...validGRN, items: [] }).success).toBe(false);
  });

  it('rejects negative quantity received', () => {
    const grn = { ...validGRN, items: [{ ...validGRN.items[0]!, quantityReceived: -5 }] };
    expect(validateGRN(grn).success).toBe(false);
  });

  it('rejects negative quantity rejected', () => {
    const grn = { ...validGRN, items: [{ ...validGRN.items[0]!, quantityRejected: -2 }] };
    expect(validateGRN(grn).success).toBe(false);
  });

  it('accepts partial delivery', () => {
    const grn = { ...validGRN, items: [{ ...validGRN.items[0]!, quantityReceived: 50 }] };
    expect(validateGRN(grn).success).toBe(true);
  });

  it('accepts delivery with rejections', () => {
    const grn = {
      ...validGRN,
      items: [{ poItemId: 'poi-001', quantityReceived: 90, quantityRejected: 10, notes: 'Damaged' }],
    };
    expect(validateGRN(grn).success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THREE-WAY MATCHING (PO → GRN → Invoice)
// ═══════════════════════════════════════════════════════════════════════════

describe('Three-Way Match', () => {
  it('fully matches when all quantities and prices align', () => {
    const result = calculateThreeWayMatch({
      poQuantity: 100,
      poUnitPrice: 50,
      grnQuantity: 100,
      invoiceQuantity: 100,
      invoiceUnitPrice: 50,
    });
    expect(result.status).toBe('fully_matched');
    expect(result.quantityVariance).toBe(0);
    expect(result.priceVariance).toBe(0);
  });

  it('detects quantity variance (GRN vs PO)', () => {
    const result = calculateThreeWayMatch({
      poQuantity: 100,
      poUnitPrice: 50,
      grnQuantity: 90,
      invoiceQuantity: 90,
      invoiceUnitPrice: 50,
    });
    expect(result.status).toBe('quantity_variance');
    expect(result.quantityVariance).toBe(-10);
  });

  it('detects price variance (Invoice vs PO)', () => {
    const result = calculateThreeWayMatch({
      poQuantity: 100,
      poUnitPrice: 50,
      grnQuantity: 100,
      invoiceQuantity: 100,
      invoiceUnitPrice: 55,
    });
    expect(result.status).toBe('price_variance');
    expect(result.priceVariance).toBe(5);
  });

  it('detects both quantity and price variance', () => {
    const result = calculateThreeWayMatch({
      poQuantity: 100,
      poUnitPrice: 50,
      grnQuantity: 90,
      invoiceQuantity: 90,
      invoiceUnitPrice: 55,
    });
    expect(result.status).toBe('variance');
    expect(result.quantityVariance).toBe(-10);
    expect(result.priceVariance).toBe(5);
  });

  it('allows tolerance within 2% for price', () => {
    const result = calculateThreeWayMatch({
      poQuantity: 100,
      poUnitPrice: 100,
      grnQuantity: 100,
      invoiceQuantity: 100,
      invoiceUnitPrice: 101.50, // 1.5% variance — within tolerance
    }, { priceTolerance: 0.02 });
    expect(result.status).toBe('fully_matched');
  });

  it('flags when invoice qty exceeds GRN qty', () => {
    const result = calculateThreeWayMatch({
      poQuantity: 100,
      poUnitPrice: 50,
      grnQuantity: 80,
      invoiceQuantity: 100, // Invoiced more than received
      invoiceUnitPrice: 50,
    });
    expect(result.status).toBe('over_invoiced');
  });

  it('calculates total variance amount', () => {
    const result = calculateThreeWayMatch({
      poQuantity: 100,
      poUnitPrice: 50,
      grnQuantity: 100,
      invoiceQuantity: 100,
      invoiceUnitPrice: 55, // R5 over per unit
    });
    expect(result.totalVarianceAmount).toBe(500); // 100 * R5
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NUMBER GENERATION
// ═══════════════════════════════════════════════════════════════════════════

describe('PO Number Generation', () => {
  it('generates sequential PO numbers', () => {
    expect(generatePONumber(0)).toBe('PO-00001');
    expect(generatePONumber(4)).toBe('PO-00005');
    expect(generatePONumber(999)).toBe('PO-01000');
  });
});

describe('GRN Number Generation', () => {
  it('generates sequential GRN numbers', () => {
    expect(generateGRNNumber(0)).toBe('GRN-00001');
    expect(generateGRNNumber(9)).toBe('GRN-00010');
  });
});
