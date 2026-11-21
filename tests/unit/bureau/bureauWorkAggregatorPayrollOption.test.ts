/** aggregateBureauWork's `payroll: false` leaves the payroll signals (open pay runs, IRP5, directives, leave) unread; the default reads them. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: Object.assign(vi.fn(async () => []), { unsafe: (t: string) => ({ unsafe: t }) }) }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { aggregateBureauWork } from '@/modules/bureau/services/bureauWorkAggregatorService';

const CO = '11111111-1111-1111-1111-111111111111';
const meta = new Map([[CO, { bureau_id: '', bureau_name: '', company_id: CO, company_name: 'Co' }]]);
const TODAY = new Date('2026-11-13T08:00:00Z');
const queries = () => sqlMock.mock.calls.map(([strings]) => (strings as unknown as readonly string[]).join('?'));
const touchesPayroll = () => queries().some((q) => /payroll_run_headers|payroll_employees|payroll_leave_requests/.test(q));

beforeEach(() => sqlMock.mockClear());

describe('aggregateBureauWork payroll option', () => {
  it('payroll: false reads no payroll table', async () => {
    await aggregateBureauWork([CO], meta, TODAY, { payroll: false });
    expect(touchesPayroll()).toBe(false);
  });
  it('the default (and payroll: true) reads them', async () => {
    await aggregateBureauWork([CO], meta, TODAY);
    expect(touchesPayroll()).toBe(true);
    sqlMock.mockClear();
    await aggregateBureauWork([CO], meta, TODAY, { payroll: true });
    expect(touchesPayroll()).toBe(true);
  });
});
