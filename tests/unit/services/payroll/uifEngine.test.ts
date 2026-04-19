import { describe, it, expect } from 'vitest';
import { calculateUIF } from '@/modules/accounting/services/payroll/uifEngine';

describe('UIF engine', () => {
  it('1% employee + 1% employer on regular salary', () => {
    const result = calculateUIF(10_000, 2025);
    expect(result.employeeContribution).toBeCloseTo(100, 2);
    expect(result.employerContribution).toBeCloseTo(100, 2);
    expect(result.isCapped).toBe(false);
  });

  it('caps at R17,712/month ceiling', () => {
    const result = calculateUIF(25_000, 2025);
    expect(result.employeeContribution).toBeCloseTo(177.12, 2);
    expect(result.employerContribution).toBeCloseTo(177.12, 2);
    expect(result.isCapped).toBe(true);
  });

  it('salary exactly at ceiling — no cap', () => {
    const result = calculateUIF(17_712, 2025);
    expect(result.employeeContribution).toBeCloseTo(177.12, 2);
    expect(result.isCapped).toBe(false);
  });

  it('salary just above ceiling — caps', () => {
    const result = calculateUIF(17_713, 2025);
    expect(result.isCapped).toBe(true);
    expect(result.employeeContribution).toBeCloseTo(177.12, 2);
  });

  it('zero salary → zero UIF', () => {
    const result = calculateUIF(0, 2025);
    expect(result.employeeContribution).toBe(0);
    expect(result.employeeContribution).toBe(0);
  });
});
