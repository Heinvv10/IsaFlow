/**
 * The MCP connector setting a company owner or admin sees and switches on /accounting/settings/integrations-mcp.
 *
 * Precedence (migration 1056, which holds the SQL side):
 *   1. hasFeature is unchanged: override row, else is_global, else plan. mcp_connector stays non-global, in no plan.
 *   2. A row with enabled = false written by a platform admin (set_via NULL or 'platform_admin') is a compliance
 *      lock: owners and admins cannot switch it on.
 *   3. Owners and admins can always switch it off, whoever switched it on.
 *   4. A platform admin can always set either state; that write is stamped platform_admin.
 *   5. A platform admin removing the row is not a lock (no row = off, and an owner may switch it on).
 *   6. Existing companies with no row are off and may self-serve on.
 * Switching off revokes nothing: /api/mcp checks hasFeature on every call, so existing tokens stop at once, and
 * they work again if it is switched back on.
 */
import { sql } from '@/lib/neon';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { MCP_CONNECTOR_FEATURE } from '@/lib/auth/connectorCompanies';

export type OverrideSetVia = 'platform_admin' | 'company_admin' | 'default_new_company';

export interface ConnectorSetting {
  enabled: boolean;
  lockedByPlatform: boolean;
}

export type SelfServeResult = 'ok' | 'unchanged' | 'locked' | 'forbidden';

export interface SelfServeOutcome {
  result: SelfServeResult;
  wasEnabled: boolean | null;
  wasSetVia: string | null;
}

/** Rule 2: a platform admin's OFF row (NULL set_via reads as platform_admin). No row is never a lock. */
export function isLockedByPlatform(row: { enabled: boolean; set_via: string | null } | null): boolean {
  return row !== null && !row.enabled && (row.set_via ?? 'platform_admin') === 'platform_admin';
}

export async function getConnectorSetting(companyId: string): Promise<ConnectorSetting> {
  const enabled = await hasFeature(companyId, MCP_CONNECTOR_FEATURE);
  const rows = await sql<{ enabled: boolean; set_via: string | null }>`
    SELECT o.enabled, o.set_via
      FROM company_feature_overrides o
      JOIN feature_flags ff ON ff.id = o.feature_id
     WHERE o.company_id = ${companyId}::uuid AND ff.code = ${MCP_CONNECTOR_FEATURE}
     LIMIT 1
  `;
  return { enabled, lockedByPlatform: isLockedByPlatform(rows[0] ?? null) };
}

const RESULTS: readonly SelfServeResult[] = ['ok', 'unchanged', 'locked', 'forbidden'];

/** The SQL function checks the session company and the owner/admin role again; anything unexpected is forbidden. */
export async function setConnectorSelfServe(companyId: string, enabled: boolean): Promise<SelfServeOutcome> {
  const rows = await sql<{ result: string; was_enabled: boolean | null; was_set_via: string | null }>`
    SELECT result, was_enabled, was_set_via FROM public.mcp_connector_self_serve_set(${companyId}::uuid, ${enabled})
  `;
  const r = rows[0];
  const result = (RESULTS as readonly string[]).includes(r?.result ?? '') ? (r!.result as SelfServeResult) : 'forbidden';
  return { result, wasEnabled: r?.was_enabled ?? null, wasSetVia: r?.was_set_via ?? null };
}
