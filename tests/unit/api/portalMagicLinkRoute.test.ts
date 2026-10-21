/**
 * Audit S-08 — POST /api/accounting/portal/auth answers every email alike.
 * A failure while creating links (which only happens for an email that
 * exists) is logged and still answered 200 { sent: true }; a live company with
 * a blank name is labelled 'Your company'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  createMagicLink: vi.fn(),
  notify: vi.fn(),
  logError: vi.fn(),
  live: [] as Array<{ companyId: string; companyName: string }>,
}));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => [{ id: 'k1', company_id: 'co-1', name: 'Jo', email: 'jo@client.co' }]),
}));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true), getClientIp: () => '127.0.0.1' }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: h.logError, debug: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/auth/liveCompanies', () => ({ listLiveCompanies: vi.fn(async () => h.live) }));
vi.mock('@/modules/accounting/services/afs/magicLinkService', () => ({ createMagicLink: h.createMagicLink }));
vi.mock('@/modules/accounting/services/afs/portalNotificationService', () => ({ notifyMagicLinkRequested: h.notify }));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import handler from '../../../pages/api/accounting/portal/auth';

async function post() {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; if (!out.status) out.status = 200; return res; },
    setHeader: vi.fn(),
  };
  await (handler as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(
    { method: 'POST', body: { email: 'jo@client.co' }, headers: {}, query: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.createMagicLink.mockResolvedValue({ token: 'a'.repeat(64), expiresAt: new Date() });
  h.live = [{ companyId: 'co-1', companyName: 'Alpha' }];
});

describe('portal magic-link route', () => {
  it('answers 200 { sent: true } and logs when a link cannot be created', async () => {
    h.createMagicLink.mockRejectedValue(new Error('insert failed'));
    const out = await post();
    expect(out.status).toBe(200);
    expect(JSON.stringify(out.body)).toContain('"sent":true');
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.logError).toHaveBeenCalledWith('Portal magic links could not be created', expect.anything(), 'portal-auth-api');
  });

  it("labels a live company with a blank name 'Your company'", async () => {
    h.live = [{ companyId: 'co-1', companyName: '' }];
    await post();
    expect(h.notify.mock.calls[0]?.[1]).toEqual([expect.objectContaining({ companyId: 'co-1', companyName: 'Your company' })]);
  });

  it('gives no link for a contact whose company is not live', async () => {
    h.live = [];
    const out = await post();
    expect(out.status).toBe(200);
    expect(h.createMagicLink).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
});
