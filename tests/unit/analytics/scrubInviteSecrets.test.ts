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
import { scrubInvitePath, scrubInviteQuery, scrubInviteReferrer } from '@/modules/analytics/scrubInviteSecrets';

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

  it('a referrer that is not a URL is still scrubbed', async () => {
    const e = await track('/accounting', null, `not a url /invite/${TOKEN}`);
    expect(e.referrer).toBe('not a url /invite/[token]');
  });

  it('ordinary pages and queries are stored exactly as sent', async () => {
    const e = await track('/accounting/reports', 'from=2026-01-01&to=2026-12-31&q=a+b', 'https://www.google.com/');
    expect(e).toMatchObject({ urlPath: '/accounting/reports', urlQuery: 'from=2026-01-01&to=2026-12-31&q=a+b', referrer: 'https://www.google.com/' });
  });
});

// The adversarial review's bypasses of a match on `/invite/` and parameter names.
const T = 'deadbeef'.repeat(8);
const lower = (v: string | null) => (v ?? '').toLowerCase();
describe.each([
  ['path', scrubInvitePath, `//invite/${T}`],
  ['path', scrubInvitePath, `/%69nvite/${T}`],
  ['path', scrubInvitePath, `/invite%2F${T}`],
  ['path', scrubInvitePath, `/Invite/${T}`],
  ['path', scrubInvitePath, `/invite/${T.toUpperCase()}`],
  ['query', scrubInviteQuery, `returnTo=%252Finvite%252F${T}`],
  ['query', scrubInviteQuery, `returnTo=//x/invite/${T}`],
  ['query', scrubInviteQuery, `returnTo=/accept-invite%3Ftoken%3D${T}`],
  ['query', scrubInviteQuery, `return=http://app/invite/${T}`],
  ['query', scrubInviteQuery, `Token=${T}`],
  ['query', scrubInviteQuery, `q=${T.slice(0, 20)}%${T.slice(20, 22)}${T.slice(22)}`],
  ['referrer', scrubInviteReferrer, `https://app.isaflow.co.za/%69nvite/${T}`],
  ['referrer', scrubInviteReferrer, `https://app.isaflow.co.za//invite/${T}`],
  ['referrer', scrubInviteReferrer, `https://app.isaflow.co.za/login?invite=%2564eadbeef${T.slice(8)}`],
] as const)('%s %s', (_kind, scrub, input) => {
  it('stores no token', () => {
    const out = lower((scrub as (v: string) => string | null)(input));
    expect(out).not.toContain(T);
    expect(out).not.toContain(T.slice(0, 32));
  });
});

// The scrub knows a token by its shape only; this keeps it honest if the minting changes.
describe('a token as the app actually mints it', () => {
  it('is redacted from a path, a query and a referrer', async () => {
    const { mintInviteToken } = await import('@/lib/auth/inviteToken');
    const minted = mintInviteToken();
    expect(scrubInvitePath(`/invite/${minted}`)).not.toContain(minted);
    expect(scrubInviteQuery(`token=${minted}`)).not.toContain(minted);
    expect(scrubInviteReferrer(`https://app.isaflow.co.za/invite/${minted}`)).not.toContain(minted);
  });
});

describe('what is not a token', () => {
  it('a 31-character hex run is stored as sent', () => {
    const notAToken = 'a'.repeat(31);
    expect(scrubInvitePath(`/accounting/x/${notAToken}`)).toBe(`/accounting/x/${notAToken}`);
  });
});

describe('a double-encoded byte in the middle of a token', () => {
  it('is decoded twice before matching: 31 hex + %2564 + 31 hex is one 63-character run', () => {
    // After one decode the run is still split (%64) into two 31-character halves: not a token.
    expect(scrubInviteQuery(`invite=${T.slice(0, 31)}%2564${T.slice(32, 63)}`)).toBe('invite=[token]');
  });
});

describe('the free-text fields', () => {
  it('a page title or event name carrying a token is redacted; event data carrying one is dropped', async () => {
    const res = { setHeader() { return this; }, status() { return this; }, json() { return this; }, end() { return this; } } as unknown as NextApiResponse;
    const req = { method: 'POST', headers: {}, body: {
      t: 'isa_app_001', p: '/x', e: 'custom', ti: `Invite ${TOKEN}`, n: `n-${TOKEN}`, d: { href: `/invite/${TOKEN}` },
    } } as unknown as NextApiRequest;
    await handler(req, res);
    const e = h.ingested.at(-1)!;
    expect(JSON.stringify(e)).not.toContain(TOKEN);
    expect(e.pageTitle).toBe('Invite [token]');
    expect(e.eventData).toBeNull();
  });

  it('event data without one is stored as sent', async () => {
    const res = { setHeader() { return this; }, status() { return this; }, json() { return this; }, end() { return this; } } as unknown as NextApiResponse;
    const req = { method: 'POST', headers: {}, body: { t: 'isa_app_001', p: '/x', e: 'custom', n: 'outbound', d: { href: 'https://example.com/a+b' } } } as unknown as NextApiRequest;
    await handler(req, res);
    expect(h.ingested.at(-1)!.eventData).toEqual({ href: 'https://example.com/a+b' });
  });
});
