/** The Home setup checklist's Payroll module ("Run payroll" -> /payroll/runs, and the fact that the company has employees or runs) needs Payroll read. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: h.sql }));
vi.mock('@/modules/accounting/services/bank/hasBankAccountService', () => ({ hasBankAccount: vi.fn(async () => true) }));

import { getSetupProgress } from '@/modules/accounting/services/core/setupProgressService';

beforeEach(() => {
  h.sql.mockReset();
  h.sql.mockResolvedValue([{ has_employees: true, has_payroll_runs: true, has_paye: true }]);
});

const hrefs = (p: Awaited<ReturnType<typeof getSetupProgress>>) => p.modules.flatMap((m) => m.tasks.map((t) => t.href));

describe('getSetupProgress', () => {
  it('with Payroll read: the Payroll module and its links', async () => {
    const p = await getSetupProgress('co', { payrollRead: true });
    expect(p.modules.map((m) => m.id)).toContain('payroll');
    expect(hrefs(p)).toContain('/payroll/runs');
  });
  it('without it: no Payroll module, no payroll link, and the counts leave it out', async () => {
    const all = await getSetupProgress('co', { payrollRead: true });
    const p = await getSetupProgress('co', { payrollRead: false });
    expect(p.modules.map((m) => m.id)).not.toContain('payroll');
    expect(hrefs(p).filter((h) => h.startsWith('/payroll'))).toEqual([]);
    expect(p.totalCount).toBeLessThan(all.totalCount);
  });
});
