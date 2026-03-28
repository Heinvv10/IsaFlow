/**
 * TDD: Project Accounting & Job Costing Tests
 * RED phase.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateProjectProfitability,
  calculateWIP,
  calculateBillableAmount,
  validateProject,
  validateTimeEntry,
  type ProjectFinancials,
  type TimeEntryInput,
  type ProjectInput,
  type WIPResult,
} from '@/modules/accounting/services/projectAccountingService';

// ═══════════════════════════════════════════════════════════════════════════
// PROJECT PROFITABILITY
// ═══════════════════════════════════════════════════════════════════════════

describe('Project Profitability', () => {
  it('calculates profit from revenue and costs', () => {
    const result = calculateProjectProfitability({
      totalRevenue: 200000,
      totalLabourCost: 80000,
      totalExpenses: 30000,
      totalMaterialCost: 40000,
    });
    expect(result.totalCost).toBe(150000);
    expect(result.grossProfit).toBe(50000);
    expect(result.profitMargin).toBeCloseTo(25, 0);
  });

  it('handles loss scenario', () => {
    const result = calculateProjectProfitability({
      totalRevenue: 100000,
      totalLabourCost: 80000,
      totalExpenses: 40000,
      totalMaterialCost: 20000,
    });
    expect(result.grossProfit).toBe(-40000);
    expect(result.profitMargin).toBeLessThan(0);
  });

  it('handles zero revenue', () => {
    const result = calculateProjectProfitability({
      totalRevenue: 0,
      totalLabourCost: 5000,
      totalExpenses: 0,
      totalMaterialCost: 0,
    });
    expect(result.profitMargin).toBe(0);
    expect(result.totalCost).toBe(5000);
  });

  it('calculates cost breakdown percentages', () => {
    const result = calculateProjectProfitability({
      totalRevenue: 200000,
      totalLabourCost: 100000,
      totalExpenses: 30000,
      totalMaterialCost: 20000,
    });
    expect(result.labourPercent).toBeCloseTo(66.67, 0);
    expect(result.expensePercent).toBeCloseTo(20, 0);
    expect(result.materialPercent).toBeCloseTo(13.33, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WORK IN PROGRESS (WIP)
// ═══════════════════════════════════════════════════════════════════════════

describe('WIP Calculation', () => {
  it('calculates WIP from costs and billing', () => {
    const result = calculateWIP({
      totalCostsIncurred: 120000,
      totalBilled: 80000,
      budgetTotal: 200000,
      percentComplete: 60,
    });
    expect(result.wipBalance).toBe(40000); // costs incurred - billed
  });

  it('calculates earned revenue based on % complete', () => {
    const result = calculateWIP({
      totalCostsIncurred: 100000,
      totalBilled: 60000,
      budgetTotal: 200000,
      percentComplete: 50,
    });
    expect(result.earnedRevenue).toBe(100000); // 50% of 200000
  });

  it('detects over-billing', () => {
    const result = calculateWIP({
      totalCostsIncurred: 50000,
      totalBilled: 100000,
      budgetTotal: 200000,
      percentComplete: 25,
    });
    expect(result.wipBalance).toBeLessThan(0); // over-billed
    expect(result.status).toBe('over_billed');
  });

  it('detects under-billing', () => {
    const result = calculateWIP({
      totalCostsIncurred: 100000,
      totalBilled: 40000,
      budgetTotal: 200000,
      percentComplete: 50,
    });
    expect(result.wipBalance).toBeGreaterThan(0);
    expect(result.status).toBe('under_billed');
  });

  it('handles complete project', () => {
    const result = calculateWIP({
      totalCostsIncurred: 200000,
      totalBilled: 200000,
      budgetTotal: 200000,
      percentComplete: 100,
    });
    expect(result.wipBalance).toBe(0);
    expect(result.status).toBe('fully_billed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BILLABLE AMOUNT
// ═══════════════════════════════════════════════════════════════════════════

describe('Billable Amount Calculation', () => {
  it('calculates from hours and rate', () => {
    expect(calculateBillableAmount(10, 500)).toBe(5000);
  });

  it('handles fractional hours', () => {
    expect(calculateBillableAmount(2.5, 400)).toBe(1000);
  });

  it('returns zero for zero hours', () => {
    expect(calculateBillableAmount(0, 500)).toBe(0);
  });

  it('rounds to 2 decimals', () => {
    expect(calculateBillableAmount(1.333, 100)).toBeCloseTo(133.30, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Project Validation', () => {
  const valid: ProjectInput = {
    name: 'Website Redesign',
    clientId: 'client-001',
    startDate: '2026-04-01',
    budgetAmount: 200000,
    billingMethod: 'time_and_materials',
  };

  it('accepts valid project', () => { expect(validateProject(valid).success).toBe(true); });
  it('rejects missing name', () => { expect(validateProject({ ...valid, name: '' }).success).toBe(false); });
  it('rejects missing client', () => { expect(validateProject({ ...valid, clientId: '' }).success).toBe(false); });
  it('rejects negative budget', () => { expect(validateProject({ ...valid, budgetAmount: -1 }).success).toBe(false); });
  it('accepts valid billing methods', () => {
    for (const m of ['time_and_materials', 'fixed_price', 'milestone', 'retainer']) {
      expect(validateProject({ ...valid, billingMethod: m as any }).success).toBe(true);
    }
  });
  it('rejects invalid billing method', () => { expect(validateProject({ ...valid, billingMethod: 'invalid' as any }).success).toBe(false); });
});

describe('Time Entry Validation', () => {
  const valid: TimeEntryInput = {
    employeeId: 'emp-001',
    projectId: 'proj-001',
    date: '2026-04-01',
    hours: 8,
    description: 'Development work',
    billable: true,
    hourlyRate: 500,
  };

  it('accepts valid entry', () => { expect(validateTimeEntry(valid).success).toBe(true); });
  it('rejects zero hours', () => { expect(validateTimeEntry({ ...valid, hours: 0 }).success).toBe(false); });
  it('rejects negative hours', () => { expect(validateTimeEntry({ ...valid, hours: -1 }).success).toBe(false); });
  it('rejects hours > 24', () => { expect(validateTimeEntry({ ...valid, hours: 25 }).success).toBe(false); });
  it('rejects missing project', () => { expect(validateTimeEntry({ ...valid, projectId: '' }).success).toBe(false); });
  it('rejects missing employee', () => { expect(validateTimeEntry({ ...valid, employeeId: '' }).success).toBe(false); });
  it('rejects missing description', () => { expect(validateTimeEntry({ ...valid, description: '' }).success).toBe(false); });
});
