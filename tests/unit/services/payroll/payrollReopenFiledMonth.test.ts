/**
 * Wave 7 EL (W25): which EMP201 months a regular run's reopen is judged on, and how the refusal names the EMP201.
 * The DB read itself (emp201FilingFor) is proven on real PostgreSQL in tests/integration/w7-el-emp201-filed-reopen.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(async () => []), { unsafe: vi.fn(() => '') }) }));
const filing = vi.hoisted(() => ({ byMonth: new Map<string, unknown>() }));
vi.mock('@/modules/accounting/services/payroll/payrollOffCycleCorrection', async (orig) => ({
  ...(await orig<object>()),
  emp201FilingFor: vi.fn(async (_c: string, y: number, m: number) => filing.byMonth.get(`${y}-${m}`) ?? null),
}));

import { regularReopenFiledRefusal, regularRunEmp201Months } from '@/modules/accounting/services/payroll/payrollReopenFiledMonth';
import { emp201FilingText } from '@/modules/accounting/services/payroll/payrollOffCycleCorrection';

describe('regularRunEmp201Months', () => {
  it('a monthly run paid on its period\'s last day: its period month only', () => {
    expect(regularRunEmp201Months({ period_year: 2026, period_month: 11, period_end: '2026-11-30', run_date: null }))
      .toEqual([{ year: 2026, month: 11 }]);
  });
  it('a weekly run straddling Dec/Jan, paid 2 Jan (period month = pay month): January only', () => {
    expect(regularRunEmp201Months({ period_year: 2026, period_month: 1, period_start: new Date(2025, 11, 27), period_end: new Date(2026, 0, 2), run_date: new Date(2026, 0, 2) }))
      .toEqual([{ year: 2026, month: 1 }]);
  });
  it('a monthly November run paid 2 December: November and December', () => {
    expect(regularRunEmp201Months({ period_year: 2024, period_month: 11, period_end: '2024-11-30', run_date: '2024-12-02' }))
      .toEqual([{ year: 2024, month: 11 }, { year: 2024, month: 12 }]);
  });
  it('no dates at all: the period month', () => {
    expect(regularRunEmp201Months({ period_year: 2026, period_month: 3, period_end: null, run_date: null })).toEqual([{ year: 2026, month: 3 }]);
  });
});

describe('emp201FilingText', () => {
  it('names the PRN, the legacy reference, or the finalised version', () => {
    expect(emp201FilingText({ source: 'filed_version', reference: '7123456789L00000001', versionNo: 2 })).toBe('is filed (reference 7123456789L00000001)');
    expect(emp201FilingText({ source: 'legacy_submission', reference: null, versionNo: null })).toBe('was submitted outside the return lifecycle (no reference recorded)');
    expect(emp201FilingText({ source: 'finalised_version', reference: null, versionNo: 3 })).toBe('is finalised as version 3 (not filed yet)');
  });
});

describe('regularReopenFiledRefusal', () => {
  const run = { run_kind: 'regular', period_year: 2024, period_month: 11, period_end: '2024-11-30', run_date: '2024-12-02' };
  it('null when neither month is covered; an off-cycle run is left to its own refusal', async () => {
    filing.byMonth.clear();
    expect(await regularReopenFiledRefusal('co', run)).toBeNull();
    filing.byMonth.set('2024-11', { source: 'filed_version', reference: 'X', versionNo: 1 });
    expect(await regularReopenFiledRefusal('co', { ...run, run_kind: 'off_cycle' })).toBeNull();
  });
  it('the pay date\'s month filed: refused naming it and the off-cycle remedy', async () => {
    filing.byMonth.clear();
    filing.byMonth.set('2024-12', { source: 'filed_version', reference: '7123456789L00000009', versionNo: 1 });
    expect(await regularReopenFiledRefusal('co', run)).toBe('This pay run is not reopened: the EMP201 for 2024-12 is filed '
      + '(reference 7123456789L00000009). The filed declaration stands: make the correction on an off-cycle run in a month whose EMP201 is not filed.');
  });
  it('a finalised version: refused, telling the user to amend it first', async () => {
    filing.byMonth.clear();
    filing.byMonth.set('2024-11', { source: 'finalised_version', reference: null, versionNo: 2 });
    expect(await regularReopenFiledRefusal('co', run)).toMatch(/2024-11 is finalised as version 2 \(not filed yet\)\. Amend that EMP201 version first/);
  });
});
