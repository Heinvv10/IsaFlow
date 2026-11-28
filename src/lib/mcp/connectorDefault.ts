/**
 * Default-on for the MCP connector: every path that creates a company calls this once, in the transaction that
 * created it. The SQL function (migration 1058, `enable_mcp_connector_default`) writes one `mcp_connector`
 * override row (enabled, reason MCP_DEFAULT_ON_REASON, set_via default_new_company) for a company created in the
 * last 10 minutes, never overwrites an existing row and never raises: an older company or a missing flag row
 * answers false. It is not callable by app_user; the onboarding wizard path gets it inside
 * create_company_with_owner instead.
 *
 * actorUserId is the new owner, or for an admin-created company (no owner yet) the platform admin who made it.
 */
import { sql } from '@/lib/neon';

export const MCP_DEFAULT_ON_REASON = 'Default on for new companies';

export const ENABLE_MCP_DEFAULT_SQL = 'SELECT public.enable_mcp_connector_default($1::uuid, $2::uuid) AS enabled';

/** A pg client inside the caller's transaction (tenant provisioning's migration_admin client). */
export interface DefaultOnRunner {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** On the caller's client. True when a row was written. */
export async function enableMcpConnectorDefault(
  client: DefaultOnRunner,
  companyId: string,
  actorUserId: string,
): Promise<boolean> {
  const r = await client.query<{ enabled: boolean }>(ENABLE_MCP_DEFAULT_SQL, [companyId, actorUserId]);
  return r.rows[0]?.enabled === true;
}

/** On the request `sql` (the admin pool: admin create and waitlist promote). True when a row was written. */
export async function enableMcpConnectorDefaultViaSql(companyId: string, actorUserId: string): Promise<boolean> {
  const rows = await sql<{ enabled: boolean }>`
    SELECT public.enable_mcp_connector_default(${companyId}::uuid, ${actorUserId}::uuid) AS enabled
  `;
  return rows[0]?.enabled === true;
}
