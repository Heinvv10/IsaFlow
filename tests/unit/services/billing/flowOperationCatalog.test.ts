import { describe, it, expect } from 'vitest';
import {
  FLOW_OPERATIONS,
  getFlowCost,
  getFlowCategory,
  isFlowOperation,
  type FlowOperation,
} from '@/modules/billing/services/flowOperationCatalog';

describe('flowOperationCatalog', () => {
  it('exposes all spec-defined operations', () => {
    for (const [code, op] of Object.entries(FLOW_OPERATIONS) as Array<[string, FlowOperation]>) {
      expect(op.cost, `cost for ${code}`).toBeGreaterThan(0);
      expect(Number.isInteger(op.cost), `cost for ${code} is int`).toBe(true);
      expect(['basic', 'standard', 'advanced', 'premium']).toContain(op.category);
    }
  });

  it('matches the spec cost tiers exactly', () => {
    expect(getFlowCost('bank.allocate')).toBe(1);       // basic
    expect(getFlowCost('invoice.create')).toBe(3);      // standard
    expect(getFlowCost('report.tb')).toBe(10);          // advanced
    expect(getFlowCost('afs.generate')).toBe(50);       // premium
  });

  it('getFlowCategory returns the category for a given op', () => {
    expect(getFlowCategory('bank.import')).toBe('basic');
    expect(getFlowCategory('payment.record')).toBe('standard');
    expect(getFlowCategory('vat.return')).toBe('advanced');
    expect(getFlowCategory('audit.export')).toBe('premium');
  });

  it('isFlowOperation narrows unknown strings', () => {
    expect(isFlowOperation('invoice.create')).toBe(true);
    expect(isFlowOperation('unknown.op')).toBe(false);
  });

  it('has stable category-to-cost mapping', () => {
    const byCategory: Record<string, Set<number>> = {};
    for (const op of Object.values(FLOW_OPERATIONS) as FlowOperation[]) {
      (byCategory[op.category] ??= new Set()).add(op.cost);
    }
    // Each category is single-priced, as advertised in the spec.
    expect(byCategory.basic).toEqual(new Set([1]));
    expect(byCategory.standard).toEqual(new Set([3]));
    expect(byCategory.advanced).toEqual(new Set([10]));
    expect(byCategory.premium).toEqual(new Set([50]));
  });
});
