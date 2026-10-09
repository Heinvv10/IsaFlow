/**
 * GET /api/accounting/projects?ids=… against real Postgres: the projects a
 * document already names (migration 870's line pickers), whatever the
 * 200-row list returns — this company's only, a malformed or over-long list
 * refused, and a repeated ?ids=a&ids=b refused rather than silently answered
 * with the unfiltered list.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

import handler from '../../pages/api/accounting/projects';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

async function get(ids: string | string[]): Promise<{ status: number; body: { data?: { id: string }[] } }> {
  let status = 200;
  let body: unknown = null;
  const res = {
    status: (s: number) => { status = s; return res; },
    json: (b: unknown) => { body = b; return res; },
    setHeader: () => res,
  } as unknown as NextApiResponse;
  await inTx(f.fx, () => (handler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<void>)(
    { method: 'GET', query: { ids }, companyId: f.fx.companyId } as unknown as NextApiRequest, res));
  return { status, body: body as { data?: { id: string }[] } };
}

describeIfDisposable('projects?ids= (real database)', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('returns exactly the named projects of this company — a cancelled one included, another company\'s never', async () => {
    const out = await get([f.project.p1, f.project.cancelled, f.project.foreign].join(','));
    expect(out.status).toBe(200);
    expect(out.body.data!.map((p) => p.id).sort()).toEqual([f.project.p1, f.project.cancelled].sort());
  });

  it('refuses a repeated ?ids=a&ids=b instead of answering the whole list', async () => {
    expect((await get([f.project.p1, f.project.p2])).status).toBe(400);
  });

  it('refuses more than 200 ids, and a list with no uuid in it', async () => {
    const many = Array.from({ length: 201 }, (_v, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect((await get(many.join(','))).status).toBe(400);
    expect((await get(many.slice(0, 200).join(','))).status).toBe(200);
    expect((await get('not-a-uuid')).status).toBe(400);
  });
});
