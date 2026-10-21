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
  'read:practice',
  'write:practice',
  'read:payroll',
  'write:payroll',
  'write:post',
  'offline_access',
] as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/**
 * What a client gets offered when it asks for no scope at all (FB-2), and what
 * the 401 challenge on /api/mcp hints at (`scope="..."`, MCP 2025-11-25).
 * READ scopes only, plus offline_access so the connection survives the 1-hour
 * access token. Never put a write scope here: a client that sends nothing must
 * not be offered anything that changes the books, and write:post stays opt-in
 * (consentScopes.ts) whatever this list says.
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
