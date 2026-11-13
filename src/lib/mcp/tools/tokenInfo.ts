/**
 * MCP read tool: token_info — what the connector's token can do and when it stops working.
 *
 * An agent that loses its token mid-run sees only 401s. Knowing the company, the scopes and the
 * expiry up front lets it check before a long job and tell its operator when to reconnect.
 *
 * Every figure comes from the McpToolContext the transport built from the authenticated token
 * (bearerPipeline -> pages/api/mcp). No args, no SQL; the one read is the company name, scoped to
 * ctx.companyId. Never returns token material: token_id is the PAT / authorisation row id that
 * audit_trail already shows, not a secret.
 */
import type { McpTool, McpToolContext } from '../types';
import { getCompany } from '@/modules/accounting/services/core/companyService';
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

export const tokenInfoTool: McpTool = {
  name: 'token_info',
  description:
    'The token this connection uses: the company it is bound to (id and name), how it authenticated (pat or oauth), '
    + 'its scopes, your role in the company, and when it expires. expires_at is the credential on this call; for OAuth '
    + 'the access token renews itself, so reconnect_by (the refresh token\'s expiry) is when the connector must be '
    + 're-authorised. Call it before a long run, or when a write is refused for a missing scope.',
  scope: null, // any authenticated token: it describes the token, not company data
  write: false,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const company = await getCompany(ctx.companyId); // companyId from ctx ONLY
    if (!company) return toolError(NOT_FOUND);
    return ok({
      company: { id: ctx.companyId, name: company.name },
      auth_method: ctx.authMethod ?? null,
      token_id: ctx.tokenJti,
      oauth_app_id: ctx.oauthAppId,
      role: ctx.companyRole ?? null,
      scopes: [...ctx.scopes].sort(),
      expires_at: ctx.tokenExpiresAt ?? null,
      expires_in_seconds: secondsUntil(ctx.tokenExpiresAt),
      refresh_expires_at: ctx.refreshExpiresAt ?? null,
      reconnect_by: reconnectBy(ctx),
    });
  },
};
