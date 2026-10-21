/**
 * FB-2: forgiving scope handling at /oauth/authorize.
 *
 *  - no `scope` (or an empty one) offers the read-only default set
 *  - openid / profile / email are dropped, never refused
 *  - any other unknown scope still refuses the whole request
 *  - the default carries no write scope, and write:post stays unticked
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
import { DEFAULT_MCP_SCOPES } from '@/lib/auth/oauthScopes';
import { resolveAuthorizeScopes } from '@/lib/auth/authorizeScopes';
import { partitionRequestedScopes } from '@/lib/auth/consentScopes';
import { UNKNOWN_SCOPE_MESSAGE } from '@/lib/auth/consentRejection';
import { getServerSideProps } from '../../../pages/oauth/authorize';

const COMPANY = '22222222-2222-2222-2222-222222222222';

function ctx(query: Record<string, string>) {
  return {
    req: { headers: { cookie: `${ACCESS_COOKIE}=tok` } },
    res: {},
    query: {
      client_id: 'client_abc',
      redirect_uri: 'https://claude.ai/cb',
      response_type: 'code',
      code_challenge: 'cc',
      code_challenge_method: 'S256',
      ...query,
    },
    resolvedUrl: '/oauth/authorize',
  } as unknown as Parameters<typeof getServerSideProps>[0];
}

async function propsFor(query: Record<string, string>): Promise<Record<string, unknown>> {
  const out = (await getServerSideProps(ctx(query))) as { props: Record<string, unknown> };
  return out.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOauthAppByClientId).mockResolvedValue({
    id: 'app-1', name: 'Some MCP Client', description: null, logoUrl: null, homepageUrl: null,
    redirectUris: ['https://claude.ai/cb'], clientId: 'client_abc',
    isVerified: false, isFirstParty: false, isConfidential: false,
  });
  vi.mocked(getUserCompanies).mockResolvedValue([
    { companyId: COMPANY, companyName: 'Demo Co (Fictional)', isDefault: true },
  ] as never);
});

describe('DEFAULT_MCP_SCOPES', () => {
  it('is read scopes plus offline_access, never a write scope', () => {
    expect(DEFAULT_MCP_SCOPES).toEqual([
      'read:reports', 'read:invoices', 'read:contacts', 'read:bank-tx',
      'read:vat', 'read:payroll', 'read:practice', 'offline_access',
    ]);
    expect(DEFAULT_MCP_SCOPES.some((s) => s.startsWith('write:'))).toBe(false);
  });
});

describe('resolveAuthorizeScopes', () => {
  it('absent or empty scope → the default set', () => {
    for (const s of ['', '   ', ',']) {
      expect(resolveAuthorizeScopes(s)).toEqual({ ok: true, scopes: [...DEFAULT_MCP_SCOPES], defaulted: true });
    }
  });

  it('drops openid / profile / email', () => {
    expect(resolveAuthorizeScopes('openid read:reports')).toEqual({ ok: true, scopes: ['read:reports'], defaulted: false });
    expect(resolveAuthorizeScopes('profile email read:vat offline_access')).toEqual({
      ok: true, scopes: ['read:vat', 'offline_access'], defaulted: false,
    });
  });

  it('only OIDC scopes → the default set, as for an absent scope', () => {
    expect(resolveAuthorizeScopes('openid profile email')).toMatchObject({ ok: true, defaulted: true });
  });

  it('any other unknown scope still refuses', () => {
    expect(resolveAuthorizeScopes('foo:bar')).toEqual({ ok: false, unknownScope: 'foo:bar' });
    expect(resolveAuthorizeScopes('openid read:reports foo:bar')).toEqual({ ok: false, unknownScope: 'foo:bar' });
    // close-but-wrong OIDC spellings are not dropped
    expect(resolveAuthorizeScopes('OpenID')).toEqual({ ok: false, unknownScope: 'OpenID' });
  });
});

describe('/oauth/authorize getServerSideProps — scope handling', () => {
  it('no scope → consent screen lists the read-only default', async () => {
    const props = await propsFor({});
    expect(props.ok).toBe(true);
    expect(props.scopes).toEqual([...DEFAULT_MCP_SCOPES]);
  });

  it('openid read:reports → read:reports', async () => {
    const props = await propsFor({ scope: 'openid read:reports' });
    expect(props.scopes).toEqual(['read:reports']);
  });

  it('foo:bar → the constant rejection', async () => {
    const props = await propsFor({ scope: 'foo:bar' });
    expect(props).toEqual({ ok: false, error: UNKNOWN_SCOPE_MESSAGE });
  });

  it('write:post requested is still opt-in, never auto-granted', async () => {
    const props = await propsFor({ scope: 'read:reports write:post' });
    const { autoGranted, optIn } = partitionRequestedScopes(props.scopes as string[]);
    expect(autoGranted).toEqual(['read:reports']);
    expect(optIn).toEqual(['write:post']);
  });
});
