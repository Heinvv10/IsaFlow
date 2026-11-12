/**
 * Each server site that refuses because the return moved on elsewhere throws the SHARED stale code
 * (STALE_RETURN_REFUSAL), the one list the lifecycle dialog reloads on: filing a filed or a superseded version,
 * amending a superseded one, and finalising a period that already has a live version.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ getVersionForUpdate: vi.fn(), peekForm: vi.fn(), sql: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: vi.fn() }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/returns/returnVersionWrites', () => ({
  getVersionForUpdate: m.getVersionForUpdate, peekForm: m.peekForm, isLockActive: vi.fn(), markVersionFiled: vi.fn(), markVersionSuperseded: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalVatLockGuard', () => ({ takeVatLockExclusive: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockService', () => ({ unlockVatPeriod: vi.fn() }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/vatGateOverrideService', () => ({ assertVatGateClear: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/sarsComplianceService', () => ({ markSubmitted: vi.fn(), saveDraftSubmission: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({ lockCompanyPayrollApprovals: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/sarsEfilingRepo', () => ({ periodSendUncertain: vi.fn() }));
vi.mock('@/modules/accounting/services/returns/returnDrift', () => ({ driftOf: vi.fn() }));

import { markReturnFiled } from '@/modules/accounting/services/returns/fileReturn';
import { amendReturn } from '@/modules/accounting/services/returns/amendReturn';
import { assertNoLiveOverlap } from '@/modules/accounting/services/returns/returnVersionStore';
import { STALE_RETURN_REFUSAL } from '@/modules/accounting/services/returns/returnVersionTypes';

const actor = { userId: 'u1', role: 'owner' };
const version = (status: string) => ({ id: 'v1', formType: 'VAT201', versionNo: 1, status, filedReference: 'R-1', vatPeriodLockId: 'l1' });

beforeEach(() => { vi.clearAllMocks(); m.peekForm.mockResolvedValue('VAT201'); });

describe('stale refusals carry the shared code', () => {
  it('filing a filed version: ALREADY_FILED', async () => {
    m.getVersionForUpdate.mockResolvedValue(version('filed'));
    await expect(markReturnFiled('c1', 'VAT201', 'v1', 'R-2', actor))
      .rejects.toMatchObject({ status: 409, refusalCode: STALE_RETURN_REFUSAL.ALREADY_FILED });
  });

  it('filing a superseded version: VERSION_SUPERSEDED', async () => {
    m.getVersionForUpdate.mockResolvedValue(version('superseded'));
    await expect(markReturnFiled('c1', 'VAT201', 'v1', 'R-2', actor))
      .rejects.toMatchObject({ status: 409, refusalCode: STALE_RETURN_REFUSAL.VERSION_SUPERSEDED });
  });

  it('amending a superseded version: ALREADY_AMENDED', async () => {
    m.getVersionForUpdate.mockResolvedValue(version('superseded'));
    await expect(amendReturn('c1', 'VAT201', 'v1', 'a reason', actor))
      .rejects.toMatchObject({ status: 409, refusalCode: STALE_RETURN_REFUSAL.ALREADY_AMENDED });
  });

  it('finalising a period with a live version of the same period: LIVE_VERSION_EXISTS', async () => {
    m.sql.mockResolvedValue([{ version_no: 1, status: 'finalised', period_start: '2026-07-01', period_end: '2026-08-31' }]);
    await expect(assertNoLiveOverlap('c1', 'VAT201', '2026-07-01', '2026-08-31'))
      .rejects.toMatchObject({ status: 409, refusalCode: STALE_RETURN_REFUSAL.LIVE_VERSION_EXISTS });
  });
});
