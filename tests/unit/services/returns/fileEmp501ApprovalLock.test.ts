/**
 * Wave 6 EFb (review #1568): marking an EMP501 filed takes the payroll approval lock BEFORE its drift is read, as an
 * EMP201 does, so an approval or reopen in flight cannot land between the drift check and the commit. Mocked: the
 * order of the two calls is the guard; the real lock is proven for the EMP201 in its own suites.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getVersionForUpdate: vi.fn(), sql: vi.fn(), lock: vi.fn(), driftOf: vi.fn(), periodSendUncertain: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: vi.fn() }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/returns/returnVersionWrites', () => ({
  getVersionForUpdate: m.getVersionForUpdate, peekForm: vi.fn(), isLockActive: vi.fn(), markVersionFiled: vi.fn(), markVersionSuperseded: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalVatLockGuard', () => ({ takeVatLockExclusive: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockService', () => ({ unlockVatPeriod: vi.fn() }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/vatGateOverrideService', () => ({ assertVatGateClear: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/sarsComplianceService', () => ({ markSubmitted: vi.fn(), saveDraftSubmission: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({ lockCompanyPayrollApprovals: m.lock }));
vi.mock('@/modules/accounting/services/reports/sarsEfilingRepo', () => ({ periodSendUncertain: m.periodSendUncertain }));
vi.mock('@/modules/accounting/services/returns/returnDrift', () => ({ driftOf: m.driftOf }));

import { markReturnFiled } from '@/modules/accounting/services/returns/fileReturn';

const actor = { userId: 'u1', role: 'owner' };
const EMP501 = {
  id: 'v1', formType: 'EMP501', versionNo: 1, status: 'finalised', periodStart: '2025-03-01', periodEnd: '2025-08-31',
  filingFileSha256: 'a'.repeat(64), vatPeriodLockId: null, figures: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  m.getVersionForUpdate.mockResolvedValue(EMP501);
  m.sql.mockResolvedValue([]); // no other period's return has the reference
  m.periodSendUncertain.mockResolvedValue(null);
  m.driftOf.mockResolvedValue({ drifted: true, fields: [], changed: ['certificates'], unfinalRuns: 0 });
});

describe('markReturnFiled, EMP501', () => {
  it('takes the payroll approval lock for the company before reading the drift', async () => {
    await expect(markReturnFiled('c1', 'EMP501', 'v1', 'SUB123456', actor)).rejects.toMatchObject({ status: 409 });
    expect(m.lock).toHaveBeenCalledWith(null, 'c1');
    expect(m.driftOf).toHaveBeenCalledTimes(1);
    expect(m.lock.mock.invocationCallOrder[0]).toBeLessThan(m.driftOf.mock.invocationCallOrder[0]!);
  });
});
