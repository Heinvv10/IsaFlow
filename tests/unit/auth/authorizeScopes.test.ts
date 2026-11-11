/**
 * FB-2: forgiving scope handling at /oauth/authorize.
 *
 *  - no `scope` (or an empty one) offers OFFERED_MCP_SCOPES: the read-only
 *    default set plus every write scope, the writes as UNTICKED checkboxes
 *  - openid / profile / email are dropped, never refused
 *  - any other unknown scope still refuses the whole request
 *  - DEFAULT_MCP_SCOPES (the no-tick baseline) carries no write scope, and
 *    every offered write scope renders unticked
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth/gotrue', () => ({ verifyToken: vi.fn(async () => ({ sub: 'user-1' })) }));
vi.mock('@/lib/auth/oauth', async () => {
  const scopes = await import('@/lib/auth/oauthScopes');
  return {
    getOauthAppByClientId: vi.fn(),
    OAUTH_SCOPES: scopes.OAUTH_SCOPES,
  };
});
vi.mock('@/modules/accounting/services/core/companyService', () => ({ getUserCompanies: vi.fn() }));
vi.mock('@/modules/admin/services/featureFlagService', () => ({
  hasFeature: vi.fn(async () => true),
  companiesWithFeature: vi.fn(async (ids: readonly string[]) => new Set(ids)),
}));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(), apiErrorMessage: vi.fn(), assertOk: vi.fn() }));

import { getOauthAppByClientId } from '@/lib/auth/oauth';
import { getUserCompanies } from '@/modules/accounting/services/core/companyService';
import { ACCESS_COOKIE } from '@/lib/auth/cookies';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_MCP_SCOPES, OAUTH_SCOPES, OFFERED_MCP_SCOPES } from '@/lib/auth/oauthScopes';
import { resolveAuthorizeScopes } from '@/lib/auth/authorizeScopes';
import { partitionRequestedScopes } from '@/lib/auth/consentScopes';
import { UNKNOWN_SCOPE_MESSAGE } from '@/lib/auth/consentRejection';
import AuthorizePage, { getServerSideProps } from '../../../pages/oauth/authorize';

const COMPANY = '22222222-2222-2222-2222-222222222222';

function ctx(query: Record<string, string>) {
  return {
    req: { headers: { cookie: `${ACCESS_COOKIE}=tok` } },
    res: { setHeader: vi.fn() },
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

const ALL_WRITE_SCOPES = OAUTH_SCOPES.filter((s) => s.startsWith('write:'));

describe('OFFERED_MCP_SCOPES', () => {
  it('is the read baseline, every write scope, then offline_access', () => {
    expect(OFFERED_MCP_SCOPES).toEqual([
      'read:reports', 'read:invoices', 'read:contacts', 'read:bank-tx',
      'read:vat', 'read:payroll', 'read:practice',
      'write:invoices', 'write:bank-tx', 'write:journals', 'write:accounts',
      'write:contacts', 'write:vat', 'write:practice', 'write:payroll', 'write:post',
      'offline_access',
    ]);
  });

  it('includes the write scopes the Velocity sync needs, and every other write scope', () => {
    for (const s of ['write:invoices', 'write:bank-tx', 'write:journals', 'write:post']) {
      expect(OFFERED_MCP_SCOPES).toContain(s);
    }
    expect(OFFERED_MCP_SCOPES.filter((s) => s.startsWith('write:'))).toEqual(ALL_WRITE_SCOPES);
  });

  it('auto-grants exactly the read-only baseline: every offered write scope is opt-in', () => {
    const { autoGranted, optIn } = partitionRequestedScopes([...OFFERED_MCP_SCOPES]);
    expect(autoGranted).toEqual([...DEFAULT_MCP_SCOPES]);
    expect(optIn).toEqual(ALL_WRITE_SCOPES);
  });
});

describe('resolveAuthorizeScopes', () => {
  it('absent or empty scope → the offered set (writes opt-in)', () => {
    for (const s of ['', '   ', ',']) {
      expect(resolveAuthorizeScopes(s)).toEqual({ ok: true, scopes: [...OFFERED_MCP_SCOPES], defaulted: true });
    }
  });

  it('an explicit read-only request is not widened', () => {
    expect(resolveAuthorizeScopes(DEFAULT_MCP_SCOPES.join(' '))).toEqual({
      ok: true, scopes: [...DEFAULT_MCP_SCOPES], defaulted: false,
    });
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
  it('no scope → consent screen lists the offered set', async () => {
    const props = await propsFor({});
    expect(props.ok).toBe(true);
    expect(props.scopes).toEqual([...OFFERED_MCP_SCOPES]);
  });

  it('the hinted scope set renders every write scope as an UNTICKED checkbox', async () => {
    const props = await propsFor({ scope: OFFERED_MCP_SCOPES.join(' ') });
    expect(props.ok).toBe(true);
    const html = renderToStaticMarkup(createElement(AuthorizePage, props as never));
    const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(boxes).toHaveLength(ALL_WRITE_SCOPES.length);
    for (const box of boxes) expect(box).not.toMatch(/\bchecked\b/);
  });

  it('openid read:reports → read:reports', async () => {
    const props = await propsFor({ scope: 'openid read:reports' });
    expect(props.scopes).toEqual(['read:reports']);
  });

  it('foo:bar → the constant rejection', async () => {
    const props = await propsFor({ scope: 'foo:bar' });
    expect(props).toEqual({ ok: false, error: UNKNOWN_SCOPE_MESSAGE });
  });

  it('all requested write scopes are opt-in, while reads stay automatic', async () => {
    const props = await propsFor({ scope: 'read:reports write:journals write:post' });
    const { autoGranted, optIn } = partitionRequestedScopes(props.scopes as string[]);
    expect(autoGranted).toEqual(['read:reports']);
    expect(optIn).toEqual(['write:journals', 'write:post']);
  });

  it('does not load or attach existing grants for write-scope defaults', async () => {
    const props = await propsFor({ scope: 'read:reports write:journals write:accounts' });
    expect(props).not.toHaveProperty('previouslyGrantedScopesByCompany');
  });
});
