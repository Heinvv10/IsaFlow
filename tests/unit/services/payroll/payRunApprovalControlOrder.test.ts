/**
 * #1266 round 3 L2: describePayRunApproval reads the run header, and only once that has RESOLVED starts the approval
 * gate: the gate takes a bounded FOR SHARE savepoint on the request's connection (regularDirectiveRefusal), which must
 * not interleave with another query on it. Back to Promise.all, the gate would start before the header resolved.
 */
import { describe, expect, it, vi } from 'vitest';

const events: string[] = [];
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(() => new Promise((resolve) => setTimeout(() => {
    events.push('header resolved');
    resolve([{ status: 'calculated', period_month: 3, period_year: 2026, total_gross: 1, approval_grandfathered_at: null }]);
  }, 20))),
}));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalGate', () => ({
  judgePayrollApproval: vi.fn(async () => { events.push('gate started'); return { planHash: 'h' }; }),
}));
vi.mock('@/modules/accounting/services/gl/approvalGate', () => ({
  assertApprovalClearedForDocument: vi.fn(),
  describeApprovalGateForDocument: vi.fn(async () => ({ state: 'ok' })),
}));

import { describePayRunApproval } from '@/modules/accounting/services/payroll/payRunApprovalControl';

describe('describePayRunApproval', () => {
  it('starts the gate only after the header has resolved', async () => {
    await describePayRunApproval('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333');
    expect(events).toEqual(['header resolved', 'gate started']);
  });
});
