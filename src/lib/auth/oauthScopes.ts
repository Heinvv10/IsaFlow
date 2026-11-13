/**
 * OAuth scope vocabulary — ZERO imports (client-bundle safe, mirrors
 * patScopes.ts). The canonical list lives here so UI pages (consent screen)
 * can render it without pulling the pg-backed oauth service into the browser
 * bundle; oauth.ts re-exports it for server-side consumers.
 */
export const OAUTH_SCOPES = [
  'read:invoices',
  'write:invoices',
  'read:bank-tx',
  'write:bank-tx',
  'write:journals',
  'write:accounts',
  'read:reports',
  'read:contacts',
  'write:contacts',
  'read:vat',
  'write:vat',
  'write:company',
  'read:practice',
  'write:practice',
  'read:payroll',
  'write:payroll',
  'write:post',
  'offline_access',
] as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/**
 * The read-only baseline: the scopes a consent grants with no tick at all.
 * READ scopes only, plus offline_access so the connection survives the 1-hour
 * access token. Never put a write scope here: this list must stay safe to
 * grant on Authorise alone. (Every write scope is opt-in in consentScopes.ts
 * anyway, but this list must not depend on that.)
 *
 * Offering is a separate list since 2026-11-11: OFFERED_MCP_SCOPES (below) is
 * what the 401 challenge hints at and what a client that asks for nothing is
 * shown. It adds the write scopes as UNTICKED checkboxes.
 */
export const DEFAULT_MCP_SCOPES: readonly OAuthScope[] = [
  'read:reports',
  'read:invoices',
  'read:contacts',
  'read:bank-tx',
  'read:vat',
  'read:payroll',
  'read:practice',
  'offline_access',
];

/** Every write scope in the vocabulary, in OAUTH_SCOPES order. */
const WRITE_SCOPES: readonly OAuthScope[] = OAUTH_SCOPES.filter((s) => s.startsWith('write:'));

/**
 * What the 401 challenge on /api/mcp hints at (`scope="..."`, MCP 2025-11-25)
 * and what /oauth/authorize offers a client that asks for no scope (FB-2):
 * the read baseline, every write scope, then offline_access.
 *
 * Offering is not granting. Each write scope renders as an UNTICKED checkbox
 * (ConsentScopeList, AuthorizePage starts with nothing ticked); consent.ts
 * grants it only when it is in optInConfirmed (buildGrantedScopes), and a role
 * that cannot write still has it withheld (writeRoles.ts). Nothing issues a
 * token from this list directly.
 *
 * Why (2026-11-11): the hint used to be DEFAULT_MCP_SCOPES. MCP clients ask for
 * exactly the hinted set, so no client ever requested a write scope, the
 * consent screen never showed a write checkbox, and every token was read-only
 * (the Velocity daily sync could not write).
 */
export const OFFERED_MCP_SCOPES: readonly OAuthScope[] = [
  ...DEFAULT_MCP_SCOPES.filter((s) => s !== 'offline_access'),
  ...WRITE_SCOPES,
  'offline_access',
];
