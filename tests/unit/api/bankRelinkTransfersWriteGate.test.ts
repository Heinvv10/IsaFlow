/**
 * POST /api/accounting/bank-relink-transfers writes (it links bank lines to journals), so a viewer must
 * be refused before the service runs. Only `withAuth` is stubbed (to set the role); the real
 * `withWriteAccess` gate is in the route's wrapper chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({ relink: vi.fn(), role: 'viewer' }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async () => {
  const real = await vi.importActual<typeof import('@/lib/auth/withWriteAccess')>('@/lib/auth/withWriteAccess');
  return {
    withWriteAccess: real.withWriteAccess,
    withAuth: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) =>
      (req: NextApiRequest, res: NextApiResponse) => h(Object.assign(req, { companyRole: mocks.role }), res),
  };
});
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/bank/bankTransferLinkService', () => ({ relinkTransferCounterparts: mocks.relink }));

import handler from '../../../pages/api/accounting/bank-relink-transfers';

const BANK = '22222222-2222-4222-8222-222222222222';
async function post(role: string) {
  mocks.role = role;
  const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json: vi.fn(), setHeader: vi.fn() };
  await handler({ method: 'POST', companyId: '11111111-1111-4111-8111-111111111111', body: { bankAccountId: BANK } } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res.statusCode;
}

describe('bank-relink-transfers write gate', () => {
  beforeEach(() => { mocks.relink.mockReset(); mocks.relink.mockResolvedValue({ linked: 0, failed: false }); });

  it('refuses a viewer with 403 and never runs the pass', async () => {
    expect(await post('viewer')).toBe(403);
    expect(mocks.relink).not.toHaveBeenCalled();
  });

  it('lets a manager through', async () => {
    expect(await post('manager')).toBe(200);
    expect(mocks.relink).toHaveBeenCalledTimes(1);
  });
});
