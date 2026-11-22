/**
 * Review #1679 (Codex M): a run that was calculated is never deleted, even once a bonus amount edit has removed its
 * lines and returned it to draft (calculated_at stays set).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ header: {} as Record<string, unknown>, calls: [] as string[] }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    h.calls.push(text);
    if (text.includes('EXISTS (SELECT 1 FROM payroll_run_lines')) return [{ lines: false, approval: false }];
    return [];
  }),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({
  lockCompanyPayrollApprovals: vi.fn(async () => undefined),
  lockPayrollRunHeader: vi.fn(async () => h.header),
}));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn(async () => undefined) }));

import { deleteDraftPayrollRun, RunNotDeletableError } from '@/modules/accounting/services/payroll/payrollRunDelete';

const CO = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const actor = { userId: '33333333-3333-4333-8333-333333333333', userEmail: 'a@example.test', ip: null, userAgent: null, sessionId: null };
const draft = { status: 'draft', approved_at: null, pay_frequency: 'monthly', period_start: '2026-11-01' };
const deleted = () => h.calls.some((t) => t.includes('DELETE FROM payroll_run_headers'));

beforeEach(() => { h.calls.length = 0; });

describe('deleteDraftPayrollRun: calculation history', () => {
  it('a draft with no lines but a calculated_at is refused, nothing deleted', async () => {
    h.header = { ...draft, calculated_at: '2026-11-20T10:00:00Z' };
    const err = await deleteDraftPayrollRun(CO, RUN, actor as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunNotDeletableError);
    expect((err as Error).message).toMatch(/it has been calculated/);
    expect(deleted()).toBe(false);
  });

  it('a draft never calculated is deleted', async () => {
    h.header = { ...draft, calculated_at: null };
    expect(await deleteDraftPayrollRun(CO, RUN, actor as never)).toBe(true);
    expect(deleted()).toBe(true);
  });
});
