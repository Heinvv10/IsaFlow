/**
 * /oauth/authorize offers only companies with the MCP connector on
 * (incident 2026-10-28: an owner of two companies granted claude.ai to the one
 * without it; sign-in succeeded and every /api/mcp call then failed).
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
vi.mock('@/modules/admin/services/featureFlagService', () => ({ companiesWithFeature: vi.fn() }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(), apiErrorMessage: vi.fn(), assertOk: vi.fn() }));

import { getOauthAppByClientId } from '@/lib/auth/oauth';
import { getUserCompanies } from '@/modules/accounting/services/core/companyService';
import { companiesWithFeature } from '@/modules/admin/services/featureFlagService';
import { ACCESS_COOKIE, ACTIVE_COMPANY_COOKIE } from '@/lib/auth/cookies';
import { NO_CONNECTOR_COMPANY_MESSAGE } from '@/lib/auth/connectorCompanies';
import { getServerSideProps } from '../../../pages/oauth/authorize';

const ENABLED_CO = '11111111-1111-1111-1111-111111111111';
const DISABLED_CO = '22222222-2222-2222-2222-222222222222';

function ctx(activeCompany?: string, extra: Record<string, string> = {}) {
  const cookie = `${ACCESS_COOKIE}=tok${activeCompany ? `; ${ACTIVE_COMPANY_COOKIE}=${activeCompany}` : ''}`;
  return {
    req: { headers: { cookie } },
    res: { setHeader: vi.fn() },
    query: {
      client_id: 'client_abc', redirect_uri: 'https://claude.ai/cb', response_type: 'code',
      code_challenge: 'cc', code_challenge_method: 'S256', ...extra,
    },
    resolvedUrl: '/oauth/authorize',
  } as unknown as Parameters<typeof getServerSideProps>[0];
}

async function propsFor(activeCompany?: string): Promise<Record<string, unknown>> {
  return ((await getServerSideProps(ctx(activeCompany))) as { props: Record<string, unknown> }).props;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOauthAppByClientId).mockResolvedValue({
    id: 'app-1', name: 'Claude', description: null, logoUrl: null, homepageUrl: null,
    redirectUris: ['https://claude.ai/cb'], clientId: 'client_abc',
    isVerified: false, isFirstParty: false, isConfidential: false,
  });
  // The disabled company is the default membership, so the fallback selection
  // proves the filter rather than membership order.
  vi.mocked(getUserCompanies).mockResolvedValue([
    { companyId: DISABLED_CO, companyName: 'Velocity', isDefault: true },
    { companyId: ENABLED_CO, companyName: 'Velocity Fibre (Pty) Ltd', isDefault: false },
  ] as never);
  vi.mocked(companiesWithFeature).mockImplementation(async (ids) => new Set(ids.filter((id) => id === ENABLED_CO)));
});

describe('/oauth/authorize — connector-enabled companies only', () => {
  it('omits a company without the connector from the picker', async () => {
    const props = await propsFor();
    expect(props.ok).toBe(true);
    expect(props.companies).toEqual([{ id: ENABLED_CO, name: 'Velocity Fibre (Pty) Ltd' }]);
    expect(props.selectedCompanyId).toBe(ENABLED_CO);
  });

  it('never preselects the active company when its connector is off', async () => {
    expect((await propsFor(DISABLED_CO)).selectedCompanyId).toBe(ENABLED_CO);
  });

  it('no company has the connector and no state was sent: the page, with the message and the settings link', async () => {
    vi.mocked(companiesWithFeature).mockResolvedValue(new Set());
    expect(await propsFor()).toEqual({ ok: false, error: NO_CONNECTOR_COMPANY_MESSAGE, settingsHref: '/accounting/settings/integrations-mcp' });
  });

  it('no company has the connector, registered redirect_uri and a state: access_denied back to the client', async () => {
    vi.mocked(companiesWithFeature).mockResolvedValue(new Set());
    const r = (await getServerSideProps(ctx(undefined, { state: 'st-1' }))) as { redirect?: { destination: string; permanent: boolean } };
    expect(r.redirect?.permanent).toBe(false);
    const url = new URL(r.redirect!.destination);
    expect(`${url.origin}${url.pathname}`).toBe('https://claude.ai/cb');
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('error_description')).toBe(NO_CONNECTOR_COMPANY_MESSAGE);
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('iss')).toBeTruthy();
    expect(url.searchParams.get('code')).toBeNull();
  });

  it('the message names who can switch it on and where, in RFC 6749 error_description characters', () => {
    expect(NO_CONNECTOR_COMPANY_MESSAGE).toMatch(/owner or admin/);
    expect(NO_CONNECTOR_COMPANY_MESSAGE).toContain('Settings > Developer > MCP Connector (AI agents)');
    expect(NO_CONNECTOR_COMPANY_MESSAGE).toMatch(/^[\x20-\x21\x23-\x5B\x5D-\x7E]+$/);
    expect(NO_CONNECTOR_COMPANY_MESSAGE).not.toMatch(/upgrade|\u2014/i);
  });

  it('an unregistered redirect_uri still gets the page, never a redirect, even with no company enabled', async () => {
    vi.mocked(companiesWithFeature).mockResolvedValue(new Set());
    const r = (await getServerSideProps(ctx(undefined, { state: 'st-1', redirect_uri: 'https://evil.example/cb' }))) as Record<string, unknown>;
    expect(r.redirect).toBeUndefined();
    expect(r.props).toEqual({ ok: false, error: 'redirect_uri is not registered for this app' });
  });

  it('an unknown client still gets the page', async () => {
    vi.mocked(getOauthAppByClientId).mockResolvedValue(null as never);
    vi.mocked(companiesWithFeature).mockResolvedValue(new Set());
    const r = (await getServerSideProps(ctx(undefined, { state: 'st-1' }))) as Record<string, unknown>;
    expect(r.redirect).toBeUndefined();
    expect(r.props).toEqual({ ok: false, error: 'Unknown OAuth client' });
  });

  it('a user with no company at all keeps the page even with a state', async () => {
    vi.mocked(getUserCompanies).mockResolvedValue([] as never);
    const r = (await getServerSideProps(ctx(undefined, { state: 'st-1' }))) as { props?: { ok: boolean; error: string } };
    expect(r.props?.ok).toBe(false);
    expect(r.props?.error).toMatch(/not linked to a company/);
  });

  it('keeps the no-company message for a user with no company at all', async () => {
    vi.mocked(getUserCompanies).mockResolvedValue([] as never);
    const props = await propsFor();
    expect(props.ok).toBe(false);
    expect(props.error).toMatch(/not linked to a company/);
    expect(companiesWithFeature).not.toHaveBeenCalled();
  });
});
