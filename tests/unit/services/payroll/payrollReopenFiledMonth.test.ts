/**
 * Wave 7 EL (W25): which EMP201 month a regular run's reopen is judged on (its period month), and how the refusal names it.
 * The DB read itself (emp201FilingFor) is proven on real PostgreSQL in tests/integration/w7-el-emp201-filed-reopen.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(async () => []), { unsafe: vi.fn(() => '') }) }));
const filing = vi.hoisted(() => ({ byMonth: new Map<string, unknown>() }));
vi.mock('@/modules/accounting/services/payroll/payrollOffCycleCorrection', async (orig) => ({
  ...(await orig<object>()),
  emp201FilingFor: vi.fn(async (_c: string, y: number, m: number) => filing.byMonth.get(`${y}-${m}`) ?? null),
}));

import { regularReopenFiledRefusal } from '@/modules/accounting/services/payroll/payrollReopenFiledMonth';
import { emp201FilingText } from '@/modules/accounting/services/payroll/payrollOffCycleCorrection';

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
  it('judged on the PERIOD month only (coordinator ruling on #1903 B2): a November run paid in December is not refused for December', async () => {
    filing.byMonth.clear();
    filing.byMonth.set('2024-12', { source: 'filed_version', reference: '7123456789L00000008', versionNo: 1 });
    expect(await regularReopenFiledRefusal('co', run)).toBeNull();
  });
  it('the period month filed: refused naming it and the off-cycle remedy', async () => {
    filing.byMonth.clear();
    filing.byMonth.set('2024-11', { source: 'filed_version', reference: '7123456789L00000009', versionNo: 1 });
    expect(await regularReopenFiledRefusal('co', run)).toBe('This pay run is not reopened: the EMP201 for 2024-11 is filed '
      + '(reference 7123456789L00000009). The filed declaration stands: make the correction on an off-cycle run in a month whose EMP201 is not filed.');
  });
  it('a finalised version: refused, telling the user to amend it first', async () => {
    filing.byMonth.clear();
    filing.byMonth.set('2024-11', { source: 'finalised_version', reference: null, versionNo: 2 });
    expect(await regularReopenFiledRefusal('co', run)).toMatch(/2024-11 is finalised as version 2 \(not filed yet\)\. Amend that EMP201 version first/);
  });
});
