/** DELETE /api/payroll/employees/[id]/components: a refused date is a 400, not a 500. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withPayrollDetailAccess', () => ({ withPayrollDetailAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeComponentService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  endEmployeeComponent: vi.fn(),
}));

import {
  EmployeeComponentRefused, endEmployeeComponent,
} from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import handler from '../../../pages/api/payroll/employees/[id]/components';

function call(body: Record<string, unknown>) {
  const req = { method: 'DELETE', query: { id: 'e1', aid: 'a1' }, body, companyId: 'co-1' } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown,
    setHeader() { return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; },
    send(p: unknown) { this.sent = p; return this; },
    end() { return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}
beforeEach(() => { vi.clearAllMocks(); });

describe('DELETE components', () => {
  it('answers 400 when the service refuses the date', async () => {
    vi.mocked(endEmployeeComponent).mockRejectedValue(new EmployeeComponentRefused('effectiveTo must be a real date (YYYY-MM-DD)'));
    const { req, res } = call({ effectiveTo: '2026-02-31' });
    await (handler as unknown as (a: unknown, b: unknown) => Promise<void>)(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('rethrows anything else', async () => {
    vi.mocked(endEmployeeComponent).mockRejectedValue(new Error('db down'));
    const { req, res } = call({ effectiveTo: '2026-03-01' });
    await expect((handler as unknown as (a: unknown, b: unknown) => Promise<void>)(req, res)).rejects.toThrow('db down');
  });
});
