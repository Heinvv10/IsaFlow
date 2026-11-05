import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({
  logAuditOrThrow: vi.fn(),
}));

import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import {
  GRANDFATHERED_PLAN_HASH,
  recordPayRunApprovalAudit,
} from '@/modules/accounting/services/payroll/payRunApprovalAudit';

describe('pay-run approval audit', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['prepared', 'requested', 'authorised', 'executed', 'reopened', 'reversed'] as const)(
    'records the %s actor with the reviewed plan hash',
    async (event) => {
      await recordPayRunApprovalAudit({
        companyId: '11111111-1111-4111-8111-111111111111',
        runId: '22222222-2222-4222-8222-222222222222',
        actorId: '33333333-3333-4333-8333-333333333333',
        event,
        planHash: 'reviewed-plan',
      });
      expect(logAuditOrThrow).toHaveBeenCalledWith(expect.objectContaining({
        userId: '33333333-3333-4333-8333-333333333333',
        changes: expect.objectContaining({ metadata: expect.objectContaining({ event, planHash: 'reviewed-plan' }) }),
      }));
    },
  );

  it('uses an explicit unavailable marker when history has no trustworthy plan hash', () => {
    expect(GRANDFATHERED_PLAN_HASH).toBe('grandfathered-plan-hash-unavailable');
  });
});
