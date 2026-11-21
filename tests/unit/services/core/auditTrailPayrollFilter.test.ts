/**
 * #1656 round 8: getAuditLog's payroll filter reaches BOTH the rows query and the COUNT (so a page is never short and the total is not a
 * side channel), and getEntityHistory refuses a payroll type without Payroll read even when called directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as Array<{ text: string; values: unknown[] }>);
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push({ text: strings.join('?'), values }); return [{ cnt: 0 }]; }),
}));

import { getAuditLog, getEntityHistory } from '@/modules/accounting/services/core/auditTrailService';
import { PAYROLL_AUDIT_ENTITY_TYPES } from '@/modules/accounting/services/core/auditPayrollTypes';

const C = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { calls.length = 0; });

describe('getAuditLog', () => {
  it('without Payroll read both queries carry the payroll types to exclude; with it neither does', async () => {
    await getAuditLog(C, { payrollRead: false });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.text).toMatch(/entity_type <> ALL\(/);
      expect(c.values).toContainEqual([...PAYROLL_AUDIT_ENTITY_TYPES]);
    }
    calls.length = 0;
    await getAuditLog(C, { payrollRead: true });
    for (const c of calls) expect(c.values).not.toContainEqual([...PAYROLL_AUDIT_ENTITY_TYPES]);
    expect(calls.every((c) => c.values.includes(null))).toBe(true);
  });
});

describe('getEntityHistory', () => {
  it('a payroll type without Payroll read reads nothing; with it, or another type, it reads', async () => {
    expect(await getEntityHistory(C, 'payroll_employee', C, false)).toEqual([]);
    expect(calls).toHaveLength(0);
    await getEntityHistory(C, 'payroll_employee', C, true);
    await getEntityHistory(C, 'supplier_invoice', C, false);
    expect(calls).toHaveLength(2);
  });
});
