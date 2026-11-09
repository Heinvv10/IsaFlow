/** finaliseEmpReturn stores directive payments as totals only: one person's pay each must not sit in the stored figures. */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(), generateEMP201: vi.fn(), isPayRunFinal: vi.fn(), insertVersion: vi.fn(), listVersionRows: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/modules/accounting/services/reports/emp201Service', () => ({ generateEMP201: m.generateEMP201 }));
vi.mock('@/modules/accounting/services/payroll/payslipFinal', () => ({ isPayRunFinal: m.isPayRunFinal }));
vi.mock('@/modules/accounting/services/returns/returnVersionStore', () => ({
  insertVersion: m.insertVersion, listVersionRows: m.listVersionRows, nextVersion: () => ({ versionNo: 1, amendsVersionId: null }),
}));

import { finaliseEmpReturn } from '@/modules/accounting/services/returns/finaliseEmpReturn';

beforeEach(() => {
  vi.clearAllMocks();
  m.sql.mockResolvedValue([{ id: 'r1', period_year: 2026, period_month: 3, approved_plan_hash: 'h', approved_at: '2026-03-31T10:00:00Z' }]);
  m.isPayRunFinal.mockResolvedValue(true);
  m.listVersionRows.mockResolvedValue([]);
  m.insertVersion.mockImplementation(async (v: unknown) => v);
  m.generateEMP201.mockResolvedValue({
    totalPAYE: 10, payrollRuns: [{ id: 'r1' }],
    directivePayments: [
      { paymentId: 'p1', directiveNumber: 'D1', paymentDate: '2026-03-10', gross: 1000.005, paye: 100 },
      { paymentId: 'p2', directiveNumber: 'D2', paymentDate: '2026-03-11', gross: 500, paye: 50 },
    ],
  });
});

describe('finaliseEmpReturn', () => {
  it('stores directive totals, never the per-payment rows', async () => {
    await finaliseEmpReturn('c1', '2026-03-01', '2026-03-31', { userId: 'u', role: 'admin' });
    const stored = m.insertVersion.mock.calls[0]![0].figures;
    expect(stored.directivePayments).toEqual([]);
    expect(stored.directiveTotals).toEqual({ count: 2, gross: 1500.01, paye: 150 });
    expect(JSON.stringify(stored)).not.toMatch(/D1|p1/);
  });

  it('refuses 409 when a summed run is not final, writing nothing', async () => {
    m.isPayRunFinal.mockResolvedValue(false);
    await expect(finaliseEmpReturn('c1', '2026-03-01', '2026-03-31', { userId: 'u', role: 'admin' }))
      .rejects.toMatchObject({ status: 409 });
    expect(m.insertVersion).not.toHaveBeenCalled();
  });
});
