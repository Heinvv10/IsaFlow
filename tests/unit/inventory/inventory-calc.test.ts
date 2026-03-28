/**
 * TDD: Inventory Calculation & Valuation Tests
 * Written BEFORE implementation — all should FAIL initially (RED).
 */

import { describe, it, expect } from 'vitest';
import {
  calculateWeightedAverage,
  calculateFIFO,
  calculateStockValue,
  validateProduct,
  validateStockAdjustment,
  generateProductCode,
  type ProductInput,
  type StockAdjustmentInput,
  type StockMovement,
  type ValuationResult,
} from '@/modules/accounting/services/inventoryService';

// ═══════════════════════════════════════════════════════════════════════════
// WEIGHTED AVERAGE COST
// ═══════════════════════════════════════════════════════════════════════════

describe('Weighted Average Cost', () => {
  it('calculates initial purchase cost', () => {
    const result = calculateWeightedAverage({
      currentQty: 0,
      currentAvgCost: 0,
      newQty: 100,
      newUnitCost: 50,
    });
    expect(result.avgCost).toBe(50);
    expect(result.totalQty).toBe(100);
    expect(result.totalValue).toBe(5000);
  });

  it('calculates weighted average after second purchase', () => {
    const result = calculateWeightedAverage({
      currentQty: 100,
      currentAvgCost: 50,
      newQty: 50,
      newUnitCost: 80,
    });
    // (100*50 + 50*80) / 150 = 9000/150 = 60
    expect(result.avgCost).toBe(60);
    expect(result.totalQty).toBe(150);
    expect(result.totalValue).toBe(9000);
  });

  it('handles zero new quantity', () => {
    const result = calculateWeightedAverage({
      currentQty: 100,
      currentAvgCost: 50,
      newQty: 0,
      newUnitCost: 0,
    });
    expect(result.avgCost).toBe(50);
    expect(result.totalQty).toBe(100);
  });

  it('handles zero current stock', () => {
    const result = calculateWeightedAverage({
      currentQty: 0,
      currentAvgCost: 0,
      newQty: 200,
      newUnitCost: 25,
    });
    expect(result.avgCost).toBe(25);
    expect(result.totalQty).toBe(200);
  });

  it('rounds to 2 decimal places', () => {
    const result = calculateWeightedAverage({
      currentQty: 3,
      currentAvgCost: 10,
      newQty: 7,
      newUnitCost: 15,
    });
    // (3*10 + 7*15) / 10 = 135/10 = 13.50
    expect(result.avgCost).toBe(13.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FIFO VALUATION
// ═══════════════════════════════════════════════════════════════════════════

describe('FIFO Valuation', () => {
  it('values stock from oldest purchases first', () => {
    const movements: StockMovement[] = [
      { type: 'purchase', qty: 100, unitCost: 10, date: '2026-01-01' },
      { type: 'purchase', qty: 50, unitCost: 15, date: '2026-02-01' },
    ];
    const result = calculateFIFO(movements, 120);
    // 100 @ R10 + 20 @ R15 = 1000 + 300 = 1300
    expect(result.totalValue).toBe(1300);
    expect(result.avgCost).toBeCloseTo(10.83, 1);
  });

  it('exhausts oldest batch before moving to next', () => {
    const movements: StockMovement[] = [
      { type: 'purchase', qty: 50, unitCost: 10, date: '2026-01-01' },
      { type: 'purchase', qty: 50, unitCost: 20, date: '2026-02-01' },
      { type: 'sale', qty: 60, unitCost: 0, date: '2026-03-01' },
    ];
    // After sale of 60: consumed all 50@10, then 10@20. Remaining: 40@20 = 800
    const result = calculateFIFO(movements, 40);
    expect(result.totalValue).toBe(800);
  });

  it('handles empty movements', () => {
    const result = calculateFIFO([], 0);
    expect(result.totalValue).toBe(0);
    expect(result.avgCost).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STOCK VALUE CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Stock Value Calculation', () => {
  it('calculates total stock value', () => {
    const result = calculateStockValue(100, 25.50);
    expect(result).toBe(2550);
  });

  it('returns zero for zero quantity', () => {
    expect(calculateStockValue(0, 100)).toBe(0);
  });

  it('returns zero for zero cost', () => {
    expect(calculateStockValue(100, 0)).toBe(0);
  });

  it('rounds to 2 decimal places', () => {
    expect(calculateStockValue(3, 10.333)).toBeCloseTo(31, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCT VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Product Validation', () => {
  const validProduct: ProductInput = {
    name: 'Widget A',
    code: 'WDG-001',
    category: 'widgets',
    type: 'inventory',
    unit: 'each',
    costPrice: 100,
    sellingPrice: 150,
    reorderLevel: 10,
    reorderQuantity: 50,
    costMethod: 'weighted_average',
  };

  it('accepts valid product', () => {
    expect(validateProduct(validProduct).success).toBe(true);
  });

  it('rejects missing name', () => {
    expect(validateProduct({ ...validProduct, name: '' }).success).toBe(false);
  });

  it('rejects missing code', () => {
    expect(validateProduct({ ...validProduct, code: '' }).success).toBe(false);
  });

  it('rejects negative cost price', () => {
    expect(validateProduct({ ...validProduct, costPrice: -10 }).success).toBe(false);
  });

  it('rejects negative selling price', () => {
    expect(validateProduct({ ...validProduct, sellingPrice: -10 }).success).toBe(false);
  });

  it('rejects negative reorder level', () => {
    expect(validateProduct({ ...validProduct, reorderLevel: -5 }).success).toBe(false);
  });

  it('accepts valid product types', () => {
    for (const t of ['inventory', 'non_inventory', 'service']) {
      expect(validateProduct({ ...validProduct, type: t as any }).success).toBe(true);
    }
  });

  it('accepts valid cost methods', () => {
    for (const m of ['weighted_average', 'fifo']) {
      expect(validateProduct({ ...validProduct, costMethod: m as any }).success).toBe(true);
    }
  });

  it('rejects invalid cost method', () => {
    expect(validateProduct({ ...validProduct, costMethod: 'lifo' as any }).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STOCK ADJUSTMENT VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Stock Adjustment Validation', () => {
  const validAdjustment: StockAdjustmentInput = {
    productId: '123e4567-e89b-12d3-a456-426614174000',
    adjustmentType: 'increase',
    quantity: 10,
    reason: 'Stock count correction',
    unitCost: 50,
  };

  it('accepts valid adjustment', () => {
    expect(validateStockAdjustment(validAdjustment).success).toBe(true);
  });

  it('rejects zero quantity', () => {
    expect(validateStockAdjustment({ ...validAdjustment, quantity: 0 }).success).toBe(false);
  });

  it('rejects negative quantity', () => {
    expect(validateStockAdjustment({ ...validAdjustment, quantity: -5 }).success).toBe(false);
  });

  it('rejects missing product ID', () => {
    expect(validateStockAdjustment({ ...validAdjustment, productId: '' }).success).toBe(false);
  });

  it('rejects missing reason', () => {
    expect(validateStockAdjustment({ ...validAdjustment, reason: '' }).success).toBe(false);
  });

  it('accepts valid adjustment types', () => {
    for (const t of ['increase', 'decrease', 'write_off', 'transfer', 'count']) {
      expect(validateStockAdjustment({ ...validAdjustment, adjustmentType: t as any }).success).toBe(true);
    }
  });

  it('requires unit cost for increases', () => {
    expect(validateStockAdjustment({ ...validAdjustment, adjustmentType: 'increase', unitCost: undefined as any }).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCT CODE GENERATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Product Code Generation', () => {
  it('generates sequential codes', () => {
    expect(generateProductCode('widgets', 0)).toBe('WDG-0001');
    expect(generateProductCode('widgets', 4)).toBe('WDG-0005');
  });

  it('uses category-based prefixes', () => {
    expect(generateProductCode('raw_materials', 0)).toMatch(/^RAW-/);
    expect(generateProductCode('finished_goods', 0)).toMatch(/^FIN-/);
    expect(generateProductCode('consumables', 0)).toMatch(/^CON-/);
  });

  it('pads to 4 digits', () => {
    expect(generateProductCode('widgets', 0)).toBe('WDG-0001');
    expect(generateProductCode('widgets', 999)).toBe('WDG-1000');
  });

  it('falls back to PRD prefix for unknown category', () => {
    expect(generateProductCode('unknown_category', 0)).toBe('PRD-0001');
  });
});
