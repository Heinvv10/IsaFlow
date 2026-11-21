/**
 * aggregateBureauWork reads the payroll signals (open pay runs with /payroll links, IRP5, directives, leave) only for
 * `payrollCompanyIds`: the clients where the caller has Payroll read. Required, so a caller must decide.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: Object.assign(vi.fn(async () => []), { unsafe: (t: string) => ({ unsafe: t }) }) }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { aggregateBureauWork } from '@/modules/bureau/services/bureauWorkAggregatorService';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const meta = new Map([A, B].map((id) => [id, { bureau_id: '', bureau_name: '', company_id: id, company_name: id }]));
const TODAY = new Date('2026-11-13T08:00:00Z');
type Call = { text: string; values: unknown[] };
const calls = (): Call[] => sqlMock.mock.calls.map(([strings, ...values]) => ({ text: (strings as unknown as readonly string[]).join('?'), values }));
const payrollCalls = () => calls().filter((c) => /payroll_run_headers|payroll_employees|payroll_leave_requests/.test(c.text));

beforeEach(() => sqlMock.mockClear());

describe('aggregateBureauWork payroll companies', () => {
  it('none: no payroll table is read', async () => {
    await aggregateBureauWork([A, B], meta, TODAY, { payrollCompanyIds: [] });
    expect(payrollCalls()).toEqual([]);
  });
  it('only the listed companies are in the payroll queries', async () => {
    await aggregateBureauWork([A, B], meta, TODAY, { payrollCompanyIds: [A] });
    const pc = payrollCalls();
    expect(pc.length).toBeGreaterThan(0);
    for (const c of pc) {
      const ids = c.values.flatMap((v) => (Array.isArray(v) ? v : []));
      expect(ids).toContain(A);
      expect(ids).not.toContain(B);
    }
  });
  it('both listed: both are read', async () => {
    await aggregateBureauWork([A, B], meta, TODAY, { payrollCompanyIds: [A, B] });
    expect(payrollCalls().every((c) => c.values.some((v) => Array.isArray(v) && v.includes(A) && v.includes(B)))).toBe(true);
  });
});
