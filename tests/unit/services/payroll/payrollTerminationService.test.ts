import { describe, it, expect } from 'vitest';

import {
  computeTerminationPreview,
  buildTerminationComponents,
  yearsOfService,
  type TerminationInput,
} from '@/modules/accounting/services/payroll/payrollTerminationService';

const base: TerminationInput = {
  monthlySalary: 21_670, // ≈ R1 000/day at 21.67 working days/month
  unusedLeaveDays: 10,
  noticePeriodDays: 30,
  servedNoticeDays: 30,
  severanceWeeksPerYear: 1,
  yearsOfService: 5,
  includeLeavePayout: true,
  reason: 'resignation',
};

describe('computeTerminationPreview', () => {
  it('pays out accrued leave × daily rate', () => {
    const out = computeTerminationPreview(base);
    // daily rate = 21 670 / 21.67 = 1000; 10 days = 10 000
    expect(out.leavePayout).toBeCloseTo(10_000, 0);
  });

  it('pays notice pay for unserved days only', () => {
    const out = computeTerminationPreview({ ...base, servedNoticeDays: 20 });
    // 10 unserved days × R1000 = 10 000
    expect(out.noticePay).toBeCloseTo(10_000, 0);
  });

  it('no severance on resignation (BCEA s41 — retrenchment only)', () => {
    const out = computeTerminationPreview({ ...base, reason: 'resignation' });
    expect(out.severancePay).toBe(0);
  });

  it('includes severance on retrenchment', () => {
    const out = computeTerminationPreview({ ...base, reason: 'retrenchment', yearsOfService: 5 });
    // 1 week × 5 years × (21670 / 4.333) ≈ 5 × 5001.15 ≈ 25 005.77
    expect(out.severancePay).toBeCloseTo(25_005.77, 1);
  });

  it('zero years of service → no severance even on retrenchment', () => {
    const out = computeTerminationPreview({ ...base, reason: 'retrenchment', yearsOfService: 0 });
    expect(out.severancePay).toBe(0);
  });

  it('respects includeLeavePayout=false', () => {
    const out = computeTerminationPreview({ ...base, includeLeavePayout: false });
    expect(out.leavePayout).toBe(0);
    expect(out.noticePay).toBeGreaterThan(-1); // still present
  });

  it('total equals sum of components', () => {
    const out = computeTerminationPreview({ ...base, reason: 'retrenchment', servedNoticeDays: 10 });
    expect(out.total).toBeCloseTo(out.leavePayout + out.noticePay + out.severancePay, 2);
  });
});

describe('buildTerminationComponents', () => {
  it('emits one EmployeeComponent per non-zero amount with SARS codes', () => {
    const comps = buildTerminationComponents({ ...base, reason: 'retrenchment', servedNoticeDays: 15 });
    const codes = comps.map((c) => c.component.sarsSourceCode);
    expect(codes).toEqual(expect.arrayContaining(['3810', '3605', '3901']));
  });

  it('skips components with zero amount', () => {
    const comps = buildTerminationComponents({ ...base, unusedLeaveDays: 0, includeLeavePayout: true });
    expect(comps.find((c) => c.component.sarsSourceCode === '3810')).toBeUndefined();
  });

  it('marks leave + notice as UIF/SDL-applicable; severance as not', () => {
    const comps = buildTerminationComponents({ ...base, reason: 'retrenchment' });
    const leave = comps.find((c) => c.component.sarsSourceCode === '3810');
    const severance = comps.find((c) => c.component.sarsSourceCode === '3901');
    expect(leave?.component.isUifApplicable).toBe(true);
    expect(severance?.component.isUifApplicable).toBe(false);
    expect(severance?.component.isSdlApplicable).toBe(false);
  });
});

describe('yearsOfService', () => {
  it('returns 0 when end precedes or equals start', () => {
    expect(yearsOfService('2026-01-01', '2025-01-01')).toBe(0);
    expect(yearsOfService('2026-01-01', '2026-01-01')).toBe(0);
  });
  it('computes fractional years', () => {
    const y = yearsOfService('2025-01-01', '2026-07-01');
    expect(y).toBeGreaterThan(1.4);
    expect(y).toBeLessThan(1.6);
  });
});
