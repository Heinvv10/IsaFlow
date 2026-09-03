/**
 * There must be exactly one way to dispose of an asset, and it must post to
 * the general ledger.
 *
 * /api/accounting/assets-disposals used to accept a POST that inserted an
 * asset_disposals row and set the asset to 'disposed' WITHOUT posting any
 * journal. The asset register and the GL then disagreed by the asset's book
 * value, with nothing on either side saying so. Production carries exactly one
 * disposal — R8,000.00 — and it has no journal_entry_id, so this fired.
 *
 * It also took no row lock and did not refuse an already-disposed asset, so
 * two concurrent requests could retire the same asset twice.
 *
 * The UI now calls POST /api/accounting/assets/:assetId/dispose, which locks
 * the row FOR UPDATE, refuses an already-disposed asset, runs the policy and
 * tax calculation and posts the journal via postAssetDisposalToGL.
 *
 * This test fails if a POST path is reintroduced on the listing endpoint.
 */

import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import disposalsHandler from '../../../pages/api/accounting/assets-disposals';

const COMPANY = 'aaaaaaaa-0000-0000-0000-0000000000d1';

function mockReqRes(method: string) {
  const req = {
    method,
    query: {},
    body: {
      assetId: 'aaaaaaaa-0000-0000-0000-0000000000d2',
      disposalDate: '2026-06-01',
      disposalMethod: 'sold',
      disposalAmount: 8000,
    },
    companyId: COMPANY,
    user: { id: 'user-1' },
  } as unknown as NextApiRequest;

  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

describe('the asset disposal listing endpoint offers no write path', () => {
  it('refuses POST', async () => {
    const { req, res } = mockReqRes('POST');
    await (disposalsHandler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(req, res);

    // 405, not 201. A POST that succeeds here retires an asset with no journal.
    expect(res.statusCode).toBe(405);
  });

  it('advertises GET as the only method it accepts', async () => {
    const { req, res } = mockReqRes('PUT');
    await (disposalsHandler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(req, res);

    expect(res.statusCode).toBe(405);
    expect(JSON.stringify(res.sent)).not.toContain('POST');
  });
});
