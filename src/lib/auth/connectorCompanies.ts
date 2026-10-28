/**
 * Which companies an OAuth grant may be pinned to: only those with the
 * `mcp_connector` feature on. /api/mcp is the only bearer route, and it answers
 * every call for a company without the feature with CONNECTOR_NOT_ENABLED. A
 * grant to such a company signs in cleanly and then fails on every request.
 *
 * Incident 2026-10-28: an owner of two companies granted claude.ai to the one
 * without the feature. Register, consent and token all succeeded; claude.ai
 * then reported "returned an error when connecting" and never reached
 * tools/list. The consent screen now offers only enabled companies, and
 * consent.ts refuses any other (the picker is UX, consent.ts is the boundary).
 */
import { hasFeature } from '@/modules/admin/services/featureFlagService';

export const MCP_CONNECTOR_FEATURE = 'mcp_connector';

export const NO_CONNECTOR_COMPANY_MESSAGE =
  'The MCP connector is not switched on for any of your companies. Contact ISAFlow support to have it switched on.';

export const CONNECTOR_COMPANY_REFUSED_MESSAGE =
  'The MCP connector is not switched on for this company. Choose another company, or contact ISAFlow support to have it switched on.';

export async function isConnectorEnabled(companyId: string): Promise<boolean> {
  return hasFeature(companyId, MCP_CONNECTOR_FEATURE);
}

/** The memberships whose company has the connector on, in their original order. */
export async function connectorEnabledMemberships<T extends { companyId: string }>(
  memberships: readonly T[],
): Promise<T[]> {
  const enabled = await Promise.all(memberships.map((m) => isConnectorEnabled(m.companyId)));
  return memberships.filter((_, i) => enabled[i]);
}
