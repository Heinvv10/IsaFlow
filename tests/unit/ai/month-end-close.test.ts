import { describe, it, expect } from 'vitest';
import {
  generateCloseChecklist,
  checkCompleteness,
  detectCutoffIssues,
  buildCloseProgressSummary,
  type CloseChecklistItem,
  type CompletenessResult,
  type CutoffIssue,
} from '@/modules/accounting/services/monthEndCloseService';

describe('Close Checklist Generation', () => {
  it('generates checklist for standard company', () => {
    const list = generateCloseChecklist('standard');
    expect(list.length).toBeGreaterThan(5);
    expect(list.every(i => i.title && i.category)).toBe(true);
  });
  it('includes bank reconciliation step', () => {
    const list = generateCloseChecklist('standard');
    expect(list.some(i => i.title.toLowerCase().includes('bank') || i.title.toLowerCase().includes('reconcil'))).toBe(true);
  });
  it('includes depreciation step', () => {
    const list = generateCloseChecklist('standard');
    expect(list.some(i => i.title.toLowerCase().includes('depreciation'))).toBe(true);
  });
  it('includes VAT step', () => {
    const list = generateCloseChecklist('standard');
    expect(list.some(i => i.title.toLowerCase().includes('vat'))).toBe(true);
  });
  it('includes payroll step', () => {
    const list = generateCloseChecklist('with_payroll');
    expect(list.some(i => i.title.toLowerCase().includes('payroll'))).toBe(true);
  });
});

describe('Completeness Check', () => {
  it('flags missing expected entries', () => {
    const result = checkCompleteness({
      hasPayrollPosted: false, hasDepreciationRun: true,
      hasBankRecon: true, hasVATRecon: true, hasAccruals: false,
    });
    expect(result.complete).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
  });
  it('passes when all complete', () => {
    const result = checkCompleteness({
      hasPayrollPosted: true, hasDepreciationRun: true,
      hasBankRecon: true, hasVATRecon: true, hasAccruals: true,
    });
    expect(result.complete).toBe(true);
    expect(result.missing.length).toBe(0);
  });
  it('returns percentage complete', () => {
    const result = checkCompleteness({
      hasPayrollPosted: true, hasDepreciationRun: true,
      hasBankRecon: false, hasVATRecon: false, hasAccruals: false,
    });
    expect(result.percentComplete).toBeCloseTo(40, 0);
  });
});

describe('Cut-off Issues', () => {
  it('flags transactions near period end in wrong period', () => {
    const issues = detectCutoffIssues({
      periodEnd: '2026-03-31',
      transactionsAfterClose: [
        { id: '1', date: '2026-04-01', amount: 5000, description: 'Backdated' },
      ],
      transactionsBeforeOpen: [],
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.type).toBe('after_close');
  });
  it('returns empty for clean data', () => {
    expect(detectCutoffIssues({ periodEnd: '2026-03-31', transactionsAfterClose: [], transactionsBeforeOpen: [] }).length).toBe(0);
  });
});

describe('Close Progress Summary', () => {
  it('builds summary with percentage', () => {
    const summary = buildCloseProgressSummary(7, 10, '2026-03');
    expect(summary.percentComplete).toBe(70);
    expect(summary.period).toBe('2026-03');
    expect(summary.status).toBeDefined();
  });
  it('100% = closed status', () => {
    expect(buildCloseProgressSummary(10, 10, '2026-03').status).toBe('closed');
  });
  it('0% = not started', () => {
    expect(buildCloseProgressSummary(0, 10, '2026-03').status).toBe('not_started');
  });
});
