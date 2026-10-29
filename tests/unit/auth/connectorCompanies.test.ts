/**
 * Consent may only pin a grant to a company with the MCP connector on
 * (incident 2026-10-28: a grant to a company without it signed in, then failed
 * every /api/mcp call).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/admin/services/featureFlagService', () => ({
  hasFeature: vi.fn(),
  companiesWithFeature: vi.fn(),
}));

import { companiesWithFeature, hasFeature } from '@/modules/admin/services/featureFlagService';
import { connectorEnabledMemberships, isConnectorEnabled } from '@/lib/auth/connectorCompanies';

const ON_A = { companyId: '11111111-1111-1111-1111-111111111111', companyName: 'Velocity Fibre (Pty) Ltd' };
const OFF = { companyId: '22222222-2222-2222-2222-222222222222', companyName: 'Velocity' };
const ON_B = { companyId: '33333333-3333-3333-3333-333333333333', companyName: 'H10 Holdings' };
const ENABLED = new Set([ON_A.companyId, ON_B.companyId]);

beforeEach(() => {
  vi.mocked(hasFeature).mockReset();
  vi.mocked(hasFeature).mockImplementation(async (companyId) => ENABLED.has(companyId));
  vi.mocked(companiesWithFeature).mockReset();
  vi.mocked(companiesWithFeature).mockImplementation(
    async (ids) => new Set(ids.filter((id) => ENABLED.has(id))),
  );
});

describe('connectorEnabledMemberships', () => {
  it('drops a company without the connector and keeps the rest in order', async () => {
    expect(await connectorEnabledMemberships([ON_A, OFF, ON_B])).toEqual([ON_A, ON_B]);
  });

  it('asks about the mcp_connector feature for every company in one call', async () => {
    await connectorEnabledMemberships([ON_A, OFF]);
    expect(vi.mocked(companiesWithFeature).mock.calls).toEqual([
      [[ON_A.companyId, OFF.companyId], 'mcp_connector'],
    ]);
    expect(hasFeature).not.toHaveBeenCalled();
  });

  it('returns nothing when no company has the connector', async () => {
    expect(await connectorEnabledMemberships([OFF])).toEqual([]);
  });
});

describe('isConnectorEnabled', () => {
  it('reads the mcp_connector feature for that company', async () => {
    expect(await isConnectorEnabled(ON_A.companyId)).toBe(true);
    expect(await isConnectorEnabled(OFF.companyId)).toBe(false);
    expect(vi.mocked(hasFeature)).toHaveBeenLastCalledWith(OFF.companyId, 'mcp_connector');
  });
});
