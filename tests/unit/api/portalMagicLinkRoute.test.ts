/**
 * Audit S-08 (breaker REPRO 2) — POST /api/accounting/portal/auth answers
 * before the lookup and send finish, so its timing says nothing about whether
 * the email has a live company. The send here never settles; the route still
 * answers 200 { sent: true } with the normalised email handed to it.
 */

import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const send = vi.hoisted(() => vi.fn(() => new Promise<void>(() => undefined)));

vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true), getClientIp: () => '127.0.0.1' }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/modules/accounting/services/afs/portalSignInLinks', () => ({ sendPortalSignInLinks: send }));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import handler from '../../../pages/api/accounting/portal/auth';

describe('portal magic-link route', () => {
  it('answers 200 { sent: true } without waiting for the send', async () => {
    const out = { status: 0, body: undefined as unknown };
    const res = {
      status(c: number) { out.status = c; return res; },
      json(b: unknown) { out.body = b; if (!out.status) out.status = 200; return res; },
      setHeader: vi.fn(),
    };
    await (handler as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(
      { method: 'POST', body: { email: '  Jo@Client.CO ' }, headers: {}, query: {} } as unknown as NextApiRequest,
      res as unknown as NextApiResponse);
    expect(out.status).toBe(200);
    expect(JSON.stringify(out.body)).toContain('"sent":true');
    expect(send).toHaveBeenCalledWith('jo@client.co', expect.any(String));
  });
});
