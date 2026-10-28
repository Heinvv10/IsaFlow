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
  return { getOauthAppByClientId: vi.fn(), OAUTH_SCOPES: scopes.OAUTH_SCOPES };
});
vi.mock('@/modules/accounting/services/core/companyService', () => ({ getUserCompanies: vi.fn() }));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: vi.fn() }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(), apiErrorMessage: vi.fn(), assertOk: vi.fn() }));

import { getOauthAppByClientId } from '@/lib/auth/oauth';
import { getUserCompanies } from '@/modules/accounting/services/core/companyService';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { ACCESS_COOKIE, ACTIVE_COMPANY_COOKIE } from '@/lib/auth/cookies';
import { NO_CONNECTOR_COMPANY_MESSAGE } from '@/lib/auth/connectorCompanies';
import { getServerSideProps } from '../../../pages/oauth/authorize';

const ENABLED_CO = '11111111-1111-1111-1111-111111111111';
const DISABLED_CO = '22222222-2222-2222-2222-222222222222';

function ctx(activeCompany?: string) {
  const cookie = `${ACCESS_COOKIE}=tok${activeCompany ? `; ${ACTIVE_COMPANY_COOKIE}=${activeCompany}` : ''}`;
  return {
    req: { headers: { cookie } },
    res: {},
    query: {
      client_id: 'client_abc', redirect_uri: 'https://claude.ai/cb', response_type: 'code',
      code_challenge: 'cc', code_challenge_method: 'S256',
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
  vi.mocked(hasFeature).mockImplementation(async (companyId) => companyId === ENABLED_CO);
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

  it('refuses with a plain reason when no company has the connector', async () => {
    vi.mocked(hasFeature).mockResolvedValue(false);
    expect(await propsFor()).toEqual({ ok: false, error: NO_CONNECTOR_COMPANY_MESSAGE });
  });

  it('keeps the no-company message for a user with no company at all', async () => {
    vi.mocked(getUserCompanies).mockResolvedValue([] as never);
    const props = await propsFor();
    expect(props.ok).toBe(false);
    expect(props.error).toMatch(/not linked to a company/);
    expect(hasFeature).not.toHaveBeenCalled();
  });
});
