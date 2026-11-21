/**
 * Wave 6 OC (review #1620, Codex on b6d6d7923): correcting a bonus amount judges whole cents as creating one does,
 * within float error, and stores the amount rounded to cents.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ calls: [] as { text: string; values: unknown[] }[] }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => []),
  withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
    const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      h.calls.push({ text, values });
      if (text.includes('FROM payroll_run_headers')) return [{ run_kind: 'off_cycle', off_cycle_reason: 'bonus', status: 'calculated' }];
      if (text.includes('SELECT amount::text')) return [{ amount: '50000.00' }];
      return [];
    };
    return fn(tx);
  }),
}));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn(async () => undefined) }));

import { setOffCycleBonusAmount } from '@/modules/accounting/services/payroll/payrollOffCycleAmount';
import { OffCycleRunRefusedError } from '@/modules/accounting/services/payroll/payrollOffCycleRun';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';

const CO = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const EMP = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const stored = (): unknown => h.calls.find((c) => c.text.includes('UPDATE payroll_off_cycle_employees'))?.values[0];

beforeEach(() => {
  h.calls.length = 0;
  vi.mocked(logAuditOrThrow).mockClear();
});

describe('setOffCycleBonusAmount: rand and cents', () => {
  it('an amount in rand and cents is stored whatever its float error', async () => {
    for (const amount of [0.07, 1.15, 4.35, 8.2, 1_000.1, 5_000.1, 99_999.99]) {
      h.calls.length = 0;
      const out = await setOffCycleBonusAmount(CO, RUN, EMP, amount, USER);
      expect(out, String(amount)).toEqual({ runId: RUN, employeeId: EMP, amount });
      expect(stored(), String(amount)).toBe(amount);
    }
  });

  it('float noise is rounded to cents before the UPDATE and in the audit row', async () => {
    const out = await setOffCycleBonusAmount(CO, RUN, EMP, 0.1 + 0.2, USER);
    expect(out?.amount).toBe(0.3);
    expect(stored()).toBe(0.3);
    const audit = vi.mocked(logAuditOrThrow).mock.calls[0]![0] as { changes: { fields: { old: string; new: string }[] } };
    expect(audit.changes.fields[0]).toMatchObject({ old: '50000.00', new: '0.30' });
  });

  it('a third decimal, nil, a negative and a non-number are refused with 400 before any read or write', async () => {
    for (const amount of [1.155, 1.005, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = await setOffCycleBonusAmount(CO, RUN, EMP, amount, USER).catch((e: unknown) => e);
      expect(err, String(amount)).toBeInstanceOf(OffCycleRunRefusedError);
      expect((err as OffCycleRunRefusedError).status).toBe(400);
      expect((err as Error).message).toMatch(/rand and cents/);
    }
    expect(h.calls).toEqual([]);
  });
});
