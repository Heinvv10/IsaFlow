import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => sqlMock(s.join('?'), v) }));

import { getDeclarablePayRun } from '@/modules/accounting/services/payroll/payrollRunQueryService';

const row = { id: 'r1', company_id: 'co', period_year: 2026, period_month: 10, status: 'approved', total_gross: '50000', total_net: '40000' };
beforeEach(() => { sqlMock.mockReset(); sqlMock.mockResolvedValue([row]); });

describe('getDeclarablePayRun', () => {
  it('reads only the statuses an EMP201 declares, scoped to the company, latest period then latest created first', async () => {
    const r = await getDeclarablePayRun('co', null);
    const [text, values] = sqlMock.mock.calls[0]! as [string, unknown[]];
    expect(values).toContain('co');
    expect(values).toContainEqual(['approved', 'paid']);
    expect(text).toMatch(/company_id = \?::UUID/);
    expect(text).toMatch(/ORDER BY period_year DESC, period_month DESC, created_at DESC, id DESC\s+LIMIT 1/);
    expect(r?.totalGross).toBe(50000);
  });
  it('a month narrows to that month; no row is null', async () => {
    sqlMock.mockResolvedValue([]);
    expect(await getDeclarablePayRun('co', { year: 2026, month: 9 })).toBeNull();
    expect(sqlMock.mock.calls[0]![1]).toEqual(expect.arrayContaining([2026, 9]));
  });
});
