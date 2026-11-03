import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/core/documentClaimLock', () => ({ claimUnderLockTimeout: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollCostCentreTags', () => ({ readEmployeeLabourSplit: vi.fn() }));

import { sql } from '@/lib/neon';
import { claimUnderLockTimeout } from '@/modules/accounting/services/core/documentClaimLock';
import { readEmployeeLabourSplit } from '@/modules/accounting/services/payroll/payrollCostCentreTags';
import { lockDirectiveLabour } from '@/modules/accounting/services/payroll/taxDirectiveLabour';

const split = {
  employeeId: '22222222-2222-4222-8222-222222222222', costCentreId: null, allocations: [], mappings: {},
  centres: new Set<string>(), taggable: new Set<string>(), advisories: [],
};

describe('lockDirectiveLabour', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sql).mockResolvedValue([{ status: 'approved', employee_id: split.employeeId }] as never);
    vi.mocked(readEmployeeLabourSplit).mockResolvedValue(split);
    vi.mocked(claimUnderLockTimeout).mockImplementation(async (_kind, take) => take());
  });

  it('puts the first cost-centre lock under the established bounded claim wait', async () => {
    await expect(lockDirectiveLabour('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'))
      .resolves.toBe(split);

    expect(claimUnderLockTimeout).toHaveBeenCalledOnce();
    expect(claimUnderLockTimeout).toHaveBeenCalledWith('tax directive', expect.any(Function));
    expect(readEmployeeLabourSplit).toHaveBeenCalledOnce();
    expect(vi.mocked(claimUnderLockTimeout).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(readEmployeeLabourSplit).mock.invocationCallOrder[0]!);
  });
});
