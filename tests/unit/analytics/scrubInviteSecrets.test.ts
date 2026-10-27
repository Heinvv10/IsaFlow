/**
 * An invitation link's token is enough to set the first password of an address
 * with no login, so it must never be stored in analytics_events. Checked
 * through the real ingest route (POST /api/track/event) with only the store
 * and the rate limit replaced: the scrub has to be wired, not just exist.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({ ingested: [] as Record<string, unknown>[] }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true), getClientIp: () => '127.0.0.1' }));
vi.mock('@/modules/analytics/services/trackingService', () => ({
  ingestEvent: vi.fn(async (e: Record<string, unknown>) => { h.ingested.push(e); return { ok: true }; }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import handler from '../../../pages/api/track/event';
import { scrubInviteQuery } from '@/modules/analytics/scrubInviteSecrets';

// Synthetic, shaped like a real one (64 hex).
const TOKEN = 'ab'.repeat(32);

async function track(p: string, q: string | null, r: string | null): Promise<Record<string, unknown>> {
  const res = {
    setHeader() { return this; }, status() { return this; }, json() { return this; }, end() { return this; },
  } as unknown as NextApiResponse;
  const req = { method: 'POST', headers: {}, body: { t: 'isa_app_001', p, q, r, e: 'pageview' } } as unknown as NextApiRequest;
  await handler(req, res);
  return h.ingested.at(-1)!;
}

beforeEach(() => { h.ingested.length = 0; });

describe('POST /api/track/event stores no invitation token', () => {
  it('the invite page path', async () => {
    const e = await track(`/invite/${TOKEN}`, null, null);
    expect(e.urlPath).toBe('/invite/[token]');
    expect(JSON.stringify(e)).not.toContain(TOKEN);
  });

  it('the acceptance page query', async () => {
    const e = await track('/accept-invite', `token=${TOKEN}`, null);
    expect(e.urlPath).toBe('/accept-invite');
    expect(JSON.stringify(e)).not.toContain(TOKEN);
  });

  it('the sign-in query, both the invite and the encoded return path', async () => {
    const e = await track('/login', `invite=${TOKEN}&returnTo=%2Finvite%2F${TOKEN}`, null);
    expect(JSON.stringify(e)).not.toContain(TOKEN);
    expect(new URLSearchParams(e.urlQuery as string).get('returnTo')).toBe('/invite/[token]');
  });

  it('the referrer of the page after the invite page', async () => {
    const e = await track('/accept-invite', null, `https://app.isaflow.co.za/invite/${TOKEN}?x=1#frag`);
    expect(JSON.stringify(e)).not.toContain(TOKEN);
    expect(e.referrer).toBe('https://app.isaflow.co.za/invite/[token]?x=1');
  });

  it('an unparseable referrer is dropped rather than stored raw', async () => {
    const e = await track('/accounting', null, `not a url /invite/${TOKEN}`);
    expect(e.referrer).toBeNull();
  });

  it('ordinary pages and queries are stored exactly as sent', async () => {
    const e = await track('/accounting/reports', 'from=2026-01-01&to=2026-12-31&q=a+b', 'https://www.google.com/');
    expect(e).toMatchObject({ urlPath: '/accounting/reports', urlQuery: 'from=2026-01-01&to=2026-12-31&q=a+b', referrer: 'https://www.google.com/' });
  });
});

describe('scrubInviteQuery', () => {
  it('matches the secret parameter names case-blind', () => {
    expect(scrubInviteQuery(`Token=${TOKEN}`)).not.toContain(TOKEN);
  });
});
