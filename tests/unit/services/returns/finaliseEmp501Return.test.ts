/**
 * The EMP501 finalise gates (wave 6 EFb): refused (409 EMP501_NOT_READY) while IRP5 pre-validation reports an error
 * or a month with a pay run has no filed EMP201, and refused before the payroll lock or any write for a window that
 * is not an EMP501 period. Wiring only (service mocks); the SQL and tenancy are proven in
 * tests/integration/mp-w6-efb-emp501-lifecycle.int.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(), preValidate: vi.fn(), lock: vi.fn(), figures: vi.fn(), insertVersion: vi.fn(), listVersionRows: vi.fn(),
  months: vi.fn(), notFinal: vi.fn(), driftOf: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(m.sql, { unsafe: (t: string) => t }) }));
vi.mock('@/modules/accounting/services/payroll/preValidationService', () => ({ preValidateTaxYear: m.preValidate }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({ lockCompanyPayrollApprovals: m.lock }));
vi.mock('@/modules/accounting/services/returns/emp501Figures', () => ({ buildEmp501Figures: m.figures }));
vi.mock('@/modules/accounting/services/returns/emp501Months', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/returns/emp501Months')>()), emp501Months: m.months, notFinalRunMonths: m.notFinal,
}));
vi.mock('@/modules/accounting/services/returns/returnDrift', () => ({ driftOf: m.driftOf }));
vi.mock('@/modules/accounting/services/returns/returnVersionStore', () => ({
  insertVersion: m.insertVersion, listVersionRows: m.listVersionRows, nextVersion: () => ({ versionNo: 1, amendsVersionId: null }),
}));

import { finaliseEmp501Return } from '@/modules/accounting/services/returns/finaliseEmp501Return';
import { ReturnRefusal } from '@/modules/accounting/services/returns/returnVersionTypes';

const actor = { userId: 'u1', role: 'admin' };
const clean = { taxYear: 2026, employeesChecked: 2, errors: 0, warnings: 1, codeReleaseLoaded: true, employees: [] };
const failing = {
  ...clean, errors: 1,
  employees: [{ employeeId: 'e1', employeeNumber: 'E1', name: 'Thandi Molefe', severity: 'error', issues: [] }],
};

async function refusal(start: string, end: string): Promise<ReturnRefusal> {
  try {
    await finaliseEmp501Return('c1', start, end, actor);
  } catch (err) {
    if (err instanceof ReturnRefusal) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  vi.clearAllMocks();
  m.sql.mockResolvedValue([]);
  m.months.mockResolvedValue([]);
  m.notFinal.mockResolvedValue([]);
  m.driftOf.mockResolvedValue({ drifted: false, fields: [], changed: [], unfinalRuns: 0 });
  m.preValidate.mockResolvedValue(clean);
  m.listVersionRows.mockResolvedValue([]);
  m.insertVersion.mockImplementation(async (v: unknown) => v);
  m.figures.mockResolvedValue({ taxYear: 2026, kind: 'annual', employer: {}, employees: [], warnings: [], totals: {}, runs: [
    { id: 'r1', approvedPlanHash: 'h', approvedAt: '2026-02-27T10:00:00.000Z' },
  ] });
});

describe('finaliseEmp501Return', () => {
  it('finalises the annual period when pre-validation is clean and every EMP201 is filed', async () => {
    await finaliseEmp501Return('c1', '2025-03-01', '2026-02-28', actor);
    expect(m.preValidate).toHaveBeenCalledWith('c1', { taxYear: 2026 });
    const v = m.insertVersion.mock.calls[0]![0];
    expect(v).toMatchObject({ form: 'EMP501', periodStart: '2025-03-01', periodEnd: '2026-02-28', vatPeriodLockId: null, finalisedBy: 'u1' });
    expect(v.postedThrough).toBe('2026-02-27T10:00:00.000Z');
  });

  it('finalises the interim period (March to August)', async () => {
    await finaliseEmp501Return('c1', '2025-03-01', '2025-08-31', actor);
    expect(m.figures.mock.calls[0]![1]).toMatchObject({ taxYear: 2026, kind: 'interim', mm: 8 });
    // Pre-validation judges the interim period only (March to August 2025).
    expect(m.preValidate).toHaveBeenCalledWith('c1', { taxYear: 2026, throughMonth: 202508 });
  });

  it('refuses 409 EMP501_NOT_READY while pre-validation reports an error, naming the employee, writing nothing', async () => {
    m.preValidate.mockResolvedValue(failing);
    const r = await refusal('2025-03-01', '2026-02-28');
    expect(r.status).toBe(409);
    expect(r.refusalCode).toBe('EMP501_NOT_READY');
    expect(r.message).toContain('Thandi Molefe');
    expect(m.figures).not.toHaveBeenCalled();
    expect(m.insertVersion).not.toHaveBeenCalled();
  });

  it('a pre-validation warning alone does not block', async () => {
    m.preValidate.mockResolvedValue({ ...clean, warnings: 3 });
    await finaliseEmp501Return('c1', '2025-03-01', '2026-02-28', actor);
    expect(m.insertVersion).toHaveBeenCalledTimes(1);
  });

  it('refuses 409 while a month with a pay run has no filed EMP201, naming the month', async () => {
    m.months.mockResolvedValue([{ month: '2025-06', totals: { paye: 1, uif: 0, sdl: 0 }, emp201: { kind: 'unfiled' } }]);
    const r = await refusal('2025-03-01', '2025-08-31');
    expect(r.refusalCode).toBe('EMP501_NOT_READY');
    expect(r.message).toContain('the EMP201 for 2025-06 is not filed');
    expect(r.refusalDetails).toEqual({ validationErrors: 0, unfiledEmp201Months: ['2025-06'], emp201Mismatches: [], driftedEmp201Months: [] });
    expect(m.insertVersion).not.toHaveBeenCalled();
  });

  it('refuses 409 when a filed EMP201 differs from the month\'s certificates, or has drifted, naming the month', async () => {
    const version = { id: 'e1', status: 'filed', figures: { totalPAYE: 4000, totalUIF: 354.24, totalSDL: 300 } };
    m.months.mockResolvedValue([
      { month: '2025-03', totals: { paye: 9000, uif: 354.24, sdl: 300 }, emp201: { kind: 'version', version } },
      { month: '2025-04', totals: { paye: 4000, uif: 354.24, sdl: 300 }, emp201: { kind: 'version', version: { ...version, id: 'e2' } } },
    ]);
    m.driftOf.mockImplementation(async (_c: string, v: { id: string }) => ({ drifted: v.id === 'e2', fields: [], changed: [], unfinalRuns: 0 }));
    const r = await refusal('2025-03-01', '2025-08-31');
    expect(r.message).toContain('March 2025: PAYE 4000.00 filed, 9000.00 on the certificates');
    expect(r.refusalDetails).toMatchObject({ driftedEmp201Months: ['2025-04'] });
    expect(m.insertVersion).not.toHaveBeenCalled();
  });

  it('a run that is not final is a warning, never a refusal', async () => {
    m.notFinal.mockResolvedValue(['2025-06']);
    await finaliseEmp501Return('c1', '2025-03-01', '2025-08-31', actor);
    expect(m.insertVersion).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['2025-03-01', '2025-09-30'], ['2025-04-01', '2026-02-28'], ['2025-03-01', '2026-02-27'], ['2025-03-01', '2025-03-31'],
  ])('refuses 400 for %s..%s (not an EMP501 period) before the lock', async (start, end) => {
    const r = await refusal(start, end);
    expect(r.status).toBe(400);
    expect(m.lock).not.toHaveBeenCalled();
  });

  it('refuses 400 for a period that has not ended', async () => {
    const r = await refusal('2099-03-01', '2099-08-31');
    expect(r.status).toBe(400);
    expect(r.message).toContain('has ended');
  });
});
