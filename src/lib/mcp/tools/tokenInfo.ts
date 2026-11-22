/**
 * MCP read tool: token_info — what the connector's token can do and when it stops working.
 *
 * An agent that loses its token mid-run sees only 401s. Knowing the company, the scopes and the
 * expiry up front lets it check before a long job and tell its operator when to reconnect.
 *
 * Every figure comes from the McpToolContext the transport built from the authenticated token
 * (bearerPipeline -> pages/api/mcp). No args, no SQL; two reads, both scoped to ctx.companyId: the
 * company name and the token holder's OWN user (ctx.userId) as an active member of that company
 * (practiceUsersService getCompanyUser, through company_member_directory), so a connector can show
 * who it is connected as. Never another member. No name set: name null. A non-member never gets
 * here: the bearer pipeline admits members only, and the company read (RLS) finds nothing for one
 * (generic not-found). Backstop: should the directory still refuse (42501, not a member), the read
 * runs in a savepoint so the call's transaction survives, and email and name are null with a warning.
 * Never returns token material: token_id is the PAT / authorisation row id that audit_trail already
 * shows, not a secret.
 */
import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { McpTool, McpToolContext } from '../types';
import { getCompany } from '@/modules/accounting/services/core/companyService';
import { getCompanyUser, type CompanyUserSummary } from '@/modules/accounting/services/practice/practiceUsersService';
import { NOT_FOUND, ok, toolError } from './toolHelpers';

function secondsUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, Math.floor((ms - Date.now()) / 1000)) : null;
}

/** OAuth access tokens are short-lived and refreshed silently; the refresh expiry is the real deadline. */
function reconnectBy(ctx: McpToolContext): string | null {
  if (ctx.authMethod === 'oauth' && ctx.refreshExpiresAt) return ctx.refreshExpiresAt;
  return ctx.tokenExpiresAt ?? null;
}

/** The token holder as a member of the token's company; null when the directory refuses them (42501, not a member). */
async function tokenHolder(ctx: McpToolContext): Promise<CompanyUserSummary | null> {
  try {
    return await withSavepoint('token_info_user', () => getCompanyUser(ctx.companyId, ctx.userId));
  } catch (err) {
    if ((err as { code?: unknown }).code !== '42501') throw err;
    log.warn('token_info: the token user is not a member of the token company', { companyId: ctx.companyId, userId: ctx.userId }, 'mcp');
    return null;
  }
}

/**
 * The tool names each GRANTED scope opens, from the registry's own `scope` metadata (nothing is listed by hand: a tool registered
 * tomorrow appears under its scope today). A tool is listed under the scope it names; a write tool that also needs another scope
 * (`requiresScope`, `write:post`) is listed under its own, and refuses a call that lacks the other. Tools that need no scope are
 * returned apart: any token opens them.
 */
export function toolsOpenedBy(tools: readonly McpTool[], granted: readonly string[]): { tools: Record<string, string[]>; tools_without_scope: string[] } {
  const names = (pick: (t: McpTool) => boolean) => tools.filter(pick).map((t) => t.name).sort();
  return {
    tools: Object.fromEntries([...new Set(granted)].sort().map((scope) => [scope, names((t) => t.scope === scope)])),
    tools_without_scope: names((t) => t.scope === null),
  };
}

/**
 * `tools` is the registry's tool list, read when the tool is called (a getter: toolIndex.ts, which builds the list, imports this
 * file). Written as a factory so this module never imports the registry.
 */
export function makeTokenInfoTool(tools: () => readonly McpTool[]): McpTool {
  return {
    name: 'token_info',
    description:
      'The token this connection uses: the company it is bound to (id and name), user = the token holder\'s own id, email '
      + 'and name (never another member; email and name null when not readable), how it authenticated (pat or oauth), '
      + 'its scopes, your role in the company, and when it expires. expires_at is the credential on this call; for OAuth '
      + 'the access token renews itself, so reconnect_by (the refresh token\'s expiry) is when the connector must be '
      + 're-authorised. tools lists, under each scope the token holds, the tools that scope opens (tools_without_scope: the ones any token opens); '
      + 'a write tool may also need another scope (read:reports, write:post), which it names when it refuses. '
      + 'Call it before a long run, or when a write is refused for a missing scope.',
    scope: null, // any authenticated token: it describes the token, not company data
    write: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const company = await getCompany(ctx.companyId); // companyId from ctx ONLY
      if (!company) return toolError(NOT_FOUND);
      const member = await tokenHolder(ctx);
      const name = member ? [member.firstName, member.lastName].filter(Boolean).join(' ') : '';
      return ok({
        company: { id: ctx.companyId, name: company.name },
        user: { id: ctx.userId, email: member?.email ?? null, name: name === '' ? null : name },
        auth_method: ctx.authMethod ?? null,
        token_id: ctx.tokenJti,
        oauth_app_id: ctx.oauthAppId,
        role: ctx.companyRole ?? null,
        scopes: [...ctx.scopes].sort(),
        ...toolsOpenedBy(tools(), ctx.scopes),
        expires_at: ctx.tokenExpiresAt ?? null,
        expires_in_seconds: secondsUntil(ctx.tokenExpiresAt),
        refresh_expires_at: ctx.refreshExpiresAt ?? null,
        reconnect_by: reconnectBy(ctx),
      });
    },
  };
}
