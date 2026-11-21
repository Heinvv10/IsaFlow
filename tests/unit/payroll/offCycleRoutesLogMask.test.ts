/**
 * Review #1679 codex B1: the off-cycle routes' request log never pairs an employee with what they are paid. Creation's
 * nested `employees[].amount` and the correction's flat `amount` are masked (withErrorHandler's maskBodyKeys), proven
 * through the real sanitizer: the employee id and the shape stay, the amount does not.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
const masks = vi.hoisted(() => [] as Array<readonly string[] | undefined>);
vi.mock('@/lib/auth', () => ({ withAuth: (h: H) => h, withWriteAccess: (h: H) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: H) => h }));
vi.mock('@/lib/auth/withPayrollDetailAccess', () => ({ withPayrollDetailAccess: (h: H) => h }));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (h: H, o?: { maskBodyKeys?: readonly string[] }) => { masks.push(o?.maskBodyKeys); return h; },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', async (importOriginal) => ({ ...await importOriginal<object>(), sql: vi.fn().mockResolvedValue([]) }));

import { maskedKeySet, sanitizeRequestBody } from '@/lib/sanitizeRequestBody';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import '../../../pages/api/payroll/runs/off-cycle';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import '../../../pages/api/payroll/runs/[id]/off-cycle-amounts';

const EMP = '11111111-1111-4111-8111-111111111111';
const CREATE = { month: 11, year: 2026, reason: 'bonus', runDate: '2026-11-25', employees: [{ employeeId: EMP, componentId: 'c1', amount: 50_000 }] };
const CORRECT = { employeeId: EMP, amount: 45_000 };

describe('off-cycle routes: the request log', () => {
  it('creation masks each employee\'s amount; the correction masks its amount', () => {
    expect(masks).toHaveLength(2);
    const [create, correct] = masks.map((m) => maskedKeySet(m));
    const c = sanitizeRequestBody(CREATE, 1, create) as { employees: Array<Record<string, unknown>>; reason: string };
    expect(String(c.employees[0]!.amount)).toMatch(/^\[omitted/);
    expect(c.employees[0]!.employeeId).toBe(EMP);
    expect(c.reason).toBe('bonus');
    const k = sanitizeRequestBody(CORRECT, 1, correct) as Record<string, unknown>;
    expect(String(k.amount)).toMatch(/^\[omitted/);
    expect(k.employeeId).toBe(EMP);
    expect(JSON.stringify([c, k])).not.toMatch(/50000|45000/);
  });
});
