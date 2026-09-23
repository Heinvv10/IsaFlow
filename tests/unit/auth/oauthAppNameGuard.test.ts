/**
 * The reserved-name rule must hold for EVERY writer, not only the one that
 * remembered it.
 *
 * It was enforced in pages/api/oauth/register.ts alone, while
 * pages/api/developer/oauth-apps/index.ts wrote body.name straight to
 * oauth_apps. The consent screen renders app.name identically whether the app
 * is dynamic or not, so any signed-in user could register an app called plainly
 * "IsaFlow" and have the screen say "IsaFlow would like to access your ISAFlow
 * account". No Unicode trick — the control was simply absent on that path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: (...args: unknown[]) => sqlMock(...args),
  getPoolForTests: vi.fn(),
}));

const logInfo = vi.fn();
vi.mock('@/lib/logger', () => ({
  log: { info: (...a: unknown[]) => logInfo(...a), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  registerOauthApp,
  ReservedClientNameError,
  getOauthAppByClientId,
  listOauthApps,
  listConnectedApps,
} from '@/lib/auth/oauth';

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([{ id: 'app-1', client_id: 'client_x' }]);
});

const input = (name: string) => ({
  ownerUserId: 'user-1',
  name,
  redirectUris: ['https://client.example/cb'],
});

describe('registerOauthApp — the guard that covers every writer', () => {
  it('refuses a reserved name however it got here', async () => {
    for (const name of ['IsaFlow', 'IsaFlow Connector', 'OfficialIsaFlow', 'Isa Flow', 'TheIsaFlow']) {
      await expect(registerOauthApp(input(name)), name).rejects.toBeInstanceOf(ReservedClientNameError);
    }
    expect(sqlMock).not.toHaveBeenCalled();
  });

  // The write path and the check must agree on the string, or a name can be
  // stored that renders as something the check never saw.
  it('stores the NFC form, and checks that same form', async () => {
    // U+FACF is a letter the browser declines to draw; NFC maps it to the
    // ideograph it stands for, which does render.
    await registerOauthApp(input('Acme𢡊Books'));
    const params = sqlMock.mock.calls[0]?.slice(1) ?? [];
    expect(params).toContain('Acme\u{2284A}Books');
    expect(params).not.toContain('Acme𢡊Books');

    // The log is a surface too. Recording the raw input while storing the
    // normalised form means the audit trail disagrees with the table about
    // what was registered.
    const logged = logInfo.mock.calls.find((c) => c[0] === 'OAuth app registered')?.[1] as
      | { name?: string }
      | undefined;
    expect(logged?.name).toBe('Acme\u{2284A}Books');
  });

  it('lets an ordinary name through untouched', async () => {
    for (const name of ['Acme Bookkeeping', '会计 (IsaFlow)', 'Claude Code (isaflow)']) {
      sqlMock.mockClear();
      await expect(registerOauthApp(input(name)), name).resolves.toBeTruthy();
      expect(sqlMock.mock.calls[0]?.slice(1), name).toContain(name);
    }
  });
});

/**
 * The write guard cannot reach a row written before it existed, and the
 * reserved-name check does not re-run at consent time. So every surface that
 * SHOWS a name normalises it, or a legacy row renders as something no check
 * ever saw — "Isa<U+FACF>Flow" draws as "Isa Flow", the name this endpoint
 * refuses.
 */
describe('reading a name written before the guard existed', () => {
  const legacy = 'Isa\uFACFFlow';
  const rendered = 'Isa\u{2284A}Flow';

  it('normalises the name the consent screen shows', async () => {
    sqlMock.mockResolvedValue([
      { id: 'a', name: legacy, description: null, logo_url: null, homepage_url: null,
        redirect_uris: ['https://c.example/cb'], client_id: 'client_x',
        is_verified: false, is_first_party: false, is_confidential: false },
    ]);
    const app = await getOauthAppByClientId('client_x');
    expect(app?.name).toBe(rendered);
    expect(app?.name).not.toContain('\uFACF');
  });

  // The revoke screen most of all: a user deciding to CUT OFF an app must see
  // the same name they granted, or they cannot match one to the other.
  it('normalises the name the connected-apps revoke screen shows', async () => {
    sqlMock.mockResolvedValue([
      { authorisation_id: 'auth-1', oauth_app_id: 'a', scopes: ['read:invoices'],
        company_id: 'c1', last_used_at: null, created_at: new Date(),
        app_name: legacy, app_logo_url: null, is_verified: false },
    ]);
    const apps = await listConnectedApps('user-1', 'c1');
    expect(apps[0]?.appName).toBe(rendered);
    expect(apps[0]?.appName).not.toContain('\uFACF');
  });

  // A logo is free branding and this screen renders it as a raw <img>. An
  // unverified app that cannot fake our branding at consent must not be able to
  // fake it on the screen where access gets revoked.
  it('withholds an unverified app\'s logo from the revoke screen', async () => {
    const row = (verified: boolean, firstParty = false) => [{
      authorisation_id: 'auth-1', oauth_app_id: 'a', scopes: [], company_id: 'c1',
      last_used_at: null, created_at: new Date(), app_name: 'Acme',
      app_logo_url: 'https://evil.example/isaflow-logo.png',
      is_verified: verified, is_first_party: firstParty,
    }];

    sqlMock.mockResolvedValue(row(false));
    const unverified = await listConnectedApps('user-1', 'c1');
    expect(unverified[0]?.appLogoUrl).toBeNull();

    sqlMock.mockResolvedValue(row(true));
    const verified = await listConnectedApps('user-1', 'c1');
    expect(verified[0]?.appLogoUrl).toBe('https://evil.example/isaflow-logo.png');
  });

  // The two screens must answer the same question. Nothing writes
  // is_first_party today, so a narrower `is_verified` check here would be
  // observationally identical — and would start showing a logo at consent and
  // an initial at revoke for the same app the moment one is marked by hand.
  it('shows a first-party app\'s logo on the revoke screen, as consent does', async () => {
    sqlMock.mockResolvedValue([{
      authorisation_id: 'auth-1', oauth_app_id: 'a', scopes: [], company_id: 'c1',
      last_used_at: null, created_at: new Date(), app_name: 'Acme',
      app_logo_url: 'https://cdn.example/logo.png',
      is_verified: false, is_first_party: true,
    }]);
    const apps = await listConnectedApps('user-1', 'c1');
    expect(apps[0]?.appLogoUrl).toBe('https://cdn.example/logo.png');
    // The badge reads appIsVerified alone, so it stays off — logo without badge,
    // exactly the shape consentAppView produces for the same app.
    expect(apps[0]?.appIsVerified).toBe(false);
  });

  // The developer list and the consent screen must not disagree about what an
  // app is called.
  it('normalises the name the developer list shows', async () => {
    sqlMock.mockResolvedValue([
      { id: 'a', name: legacy, description: null, logo_url: null, homepage_url: null,
        redirect_uris: [], client_id: 'client_x', is_verified: false,
        created_at: new Date(), revoked_at: null },
    ]);
    const apps = await listOauthApps('user-1');
    expect(apps[0]?.name).toBe(rendered);
  });
});
