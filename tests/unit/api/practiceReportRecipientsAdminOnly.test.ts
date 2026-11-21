/** #1656 round 9: adding or changing a practice report recipient (who is e-mailed the monthly report, margins included) is owner / admin only. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/practice/practiceReportRecipientsService', () => ({
  listReportRecipients: vi.fn(async () => []),
  createReportRecipient: vi.fn(async () => ({ id: 'r1' })),
  updateReportRecipient: vi.fn(async () => ({ id: 'r1' })),
  deleteReportRecipient: vi.fn(async () => undefined),
}));

import * as svc from '@/modules/accounting/services/practice/practiceReportRecipientsService';
import list from '../../../pages/api/accounting/practice/report-recipients';
import one from '../../../pages/api/accounting/practice/report-recipients/[id]';

function call(handler: unknown, method: string, role: string) {
  const req = { method, query: { id: 'r1' }, body: { email: 'a@firm.test' }, companyId: 'c', companyRole: role, user: { id: 'u' }, headers: {} } as unknown as NextApiRequest;
  const res = { statusCode: 0, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json() { return this; }, end() { return this; } };
  return Promise.resolve((handler as (a: NextApiRequest, b: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse)).then(() => res.statusCode);
}
beforeEach(() => vi.clearAllMocks());

describe('report-recipients', () => {
  it('a manager can list but not add or change; nothing is written', async () => {
    expect(await call(list, 'GET', 'manager')).toBe(200);
    expect(await call(list, 'POST', 'manager')).toBe(403);
    expect(await call(one, 'PUT', 'manager')).toBe(403);
    expect(svc.createReportRecipient).not.toHaveBeenCalled();
    expect(svc.updateReportRecipient).not.toHaveBeenCalled();
  });
  it('an owner and an admin add and change', async () => {
    for (const role of ['owner', 'admin']) {
      expect(await call(list, 'POST', role)).toBe(201);
      expect(await call(one, 'PUT', role)).toBe(200);
    }
  });
});
