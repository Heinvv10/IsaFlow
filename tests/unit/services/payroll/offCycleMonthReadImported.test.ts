/**
 * Wave 6 OC (review of fd9193cc2): an earlier line of the month that paid but rebuilds no earning (an imported line with
 * an empty breakdown) keeps its PAYE class as stored, so a flat-25% month is not reclassified on the bonus alone.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock('@/lib/neon', () => {
  const sql = Object.assign(vi.fn(async () => h.rows), { unsafe: vi.fn((s: string) => s) });
  return { sql };
});

import { loadMonthEarlierLines } from '@/modules/accounting/services/payroll/payrollOffCycleMonthRead';

const EMP = '33333333-3333-4333-8333-333333333333';
const line = (over: Record<string, unknown>) => ({
  employee_id: EMP, gross_pay: '8000.00', eti: '0', uif_employee: '80.00', uif_employer: '80.00', historic: false, stored_class: 'flat', items: [], ...over,
});

describe('loadMonthEarlierLines: an imported line', () => {
  it('a paid line with an empty breakdown keeps its stored class', async () => {
    h.rows = [line({})];
    const earlier = (await loadMonthEarlierLines('c', 'r', [EMP])).get(EMP);
    expect(earlier?.storedClass).toBe('flat');
    expect(earlier?.unrebuiltPay).toBe(8_000);
  });

  it('a line that paid nothing, or rebuilds its earnings, leaves the class to the classifier', async () => {
    h.rows = [line({ gross_pay: '0' })];
    expect((await loadMonthEarlierLines('c', 'r', [EMP])).get(EMP)?.storedClass).toBeUndefined();
    h.rows = [line({ items: [{ componentId: 'b', componentName: 'Basic', sarsSourceCode: '3601', amount: 8_000, isEarning: true, isTaxable: true, isUifApplicable: true }] })];
    expect((await loadMonthEarlierLines('c', 'r', [EMP])).get(EMP)?.storedClass).toBeUndefined();
  });
});
