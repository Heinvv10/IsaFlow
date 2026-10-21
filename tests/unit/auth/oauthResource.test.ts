/**
 * FB-4: RFC 8707 resource indicators and RFC 9207 `iss`.
 *
 *  - resource absent, or this server's /api/mcp (case-insensitive scheme and
 *    host, one trailing slash ignored), or the bare origin → accepted
 *  - any other resource → invalid_target (400 at token, error redirect at
 *    authorize, 400 at consent)
 *  - the consent redirect and the cancel redirect carry iss = metadata issuer
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth/gotrue', () => ({ verifyToken: vi.fn(async () => ({ sub: 'user-1' })) }));
vi.mock('@/lib/auth/oauth', async () => {
  const scopes = await import('@/lib/auth/oauthScopes');
  return { getOauthAppByClientId: vi.fn(), OAUTH_SCOPES: scopes.OAUTH_SCOPES };
});
vi.mock('@/modules/accounting/services/core/companyService', () => ({ getUserCompanies: vi.fn() }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(), apiErrorMessage: vi.fn(), assertOk: vi.fn() }));

import { getOauthAppByClientId } from '@/lib/auth/oauth';
import { getUserCompanies } from '@/modules/accounting/services/core/companyService';
import { ACCESS_COOKIE } from '@/lib/auth/cookies';
import {
  authorizationErrorRedirect,
  checkResourceIndicator,
  oauthIssuer,
} from '@/lib/auth/oauthResource';
import { getServerSideProps } from '../../../pages/oauth/authorize';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NEXT_PUBLIC_APP_URL;
  vi.mocked(getOauthAppByClientId).mockResolvedValue({
    id: 'app-1', name: 'Some MCP Client', description: null, logoUrl: null, homepageUrl: null,
    redirectUris: ['https://client.example/cb'], clientId: 'client_abc',
    isVerified: false, isFirstParty: false, isConfidential: false,
  });
  vi.mocked(getUserCompanies).mockResolvedValue([
    { companyId: '22222222-2222-2222-2222-222222222222', companyName: 'Demo Co (Fictional)', isDefault: true },
  ] as never);
});

describe('checkResourceIndicator', () => {
  it('accepts no resource at all', () => {
    for (const v of [undefined, null, '']) expect(checkResourceIndicator(v)).toEqual({ ok: true, bareOrigin: false });
  });

  it('accepts this server\'s MCP endpoint, case-insensitive scheme/host, one trailing slash', () => {
    for (const v of [
      'https://app.isaflow.co.za/api/mcp',
      'https://app.isaflow.co.za/api/mcp/',
      'HTTPS://APP.ISAFLOW.CO.ZA/api/mcp',
      ['https://app.isaflow.co.za/api/mcp'],
    ]) {
      expect(checkResourceIndicator(v), JSON.stringify(v)).toEqual({ ok: true, bareOrigin: false });
    }
  });

  it('accepts the bare origin, flagged so the caller can warn', () => {
    for (const v of ['https://app.isaflow.co.za', 'https://app.isaflow.co.za/']) {
      expect(checkResourceIndicator(v), v).toEqual({ ok: true, bareOrigin: true });
    }
  });

  it('refuses any other resource', () => {
    for (const v of [
      'https://evil.example/api/mcp',
      'http://app.isaflow.co.za/api/mcp',
      'https://app.isaflow.co.za/api/other',
      'https://app.isaflow.co.za/api/MCP',
      'https://app.isaflow.co.za/api/mcp//',
      'https://app.isaflow.co.za/api/mcp#frag',
      'https://app.isaflow.co.za/api/mcp?x=1',
      'https://user@app.isaflow.co.za/api/mcp',
      'not a url',
      ['https://app.isaflow.co.za/api/mcp', 'https://evil.example/api/mcp'],
      42,
    ]) {
      expect(checkResourceIndicator(v), JSON.stringify(v)).toEqual({ ok: false });
    }
  });

  it('follows NEXT_PUBLIC_APP_URL', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3200';
    expect(checkResourceIndicator('http://localhost:3200/api/mcp').ok).toBe(true);
    expect(checkResourceIndicator('https://app.isaflow.co.za/api/mcp').ok).toBe(false);
    expect(oauthIssuer()).toBe('http://localhost:3200');
  });
});

describe('authorizationErrorRedirect', () => {
  it('carries error, state and iss', () => {
    const url = new URL(authorizationErrorRedirect('https://client.example/cb?keep=1', 'access_denied', 'st', 'https://app.isaflow.co.za'));
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('iss')).toBe('https://app.isaflow.co.za');
    expect(url.searchParams.get('keep')).toBe('1');
  });
});

function ctx(query: Record<string, string>) {
  return {
    req: { headers: { cookie: `${ACCESS_COOKIE}=tok` } },
    res: {},
    query: {
      client_id: 'client_abc',
      redirect_uri: 'https://client.example/cb',
      response_type: 'code',
      code_challenge: 'cc',
      code_challenge_method: 'S256',
      scope: 'read:reports',
      state: 'st-9',
      ...query,
    },
    resolvedUrl: '/oauth/authorize',
  } as unknown as Parameters<typeof getServerSideProps>[0];
}

describe('/oauth/authorize — resource and iss', () => {
  it('a wrong resource is an invalid_target error redirect to the registered redirect_uri', async () => {
    const out = (await getServerSideProps(ctx({ resource: 'https://evil.example/api/mcp' }))) as {
      redirect: { destination: string };
    };
    const url = new URL(out.redirect.destination);
    expect(`${url.origin}${url.pathname}`).toBe('https://client.example/cb');
    expect(url.searchParams.get('error')).toBe('invalid_target');
    expect(url.searchParams.get('state')).toBe('st-9');
    expect(url.searchParams.get('iss')).toBe('https://app.isaflow.co.za');
  });

  it('never redirects an error to an unregistered redirect_uri', async () => {
    const out = (await getServerSideProps(
      ctx({ redirect_uri: 'https://evil.example/cb', resource: 'https://evil.example/api/mcp' }),
    )) as { props: Record<string, unknown> };
    expect(out.props.ok).toBe(false);
  });

  it('the right resource (or none) renders consent with resource and issuer props', async () => {
    const withRes = (await getServerSideProps(ctx({ resource: 'https://app.isaflow.co.za/api/mcp' }))) as {
      props: Record<string, unknown>;
    };
    expect(withRes.props).toMatchObject({ ok: true, resource: 'https://app.isaflow.co.za/api/mcp', issuer: 'https://app.isaflow.co.za' });

    const without = (await getServerSideProps(ctx({}))) as { props: Record<string, unknown> };
    expect(without.props).toMatchObject({ ok: true, resource: null, issuer: 'https://app.isaflow.co.za' });
  });
});
