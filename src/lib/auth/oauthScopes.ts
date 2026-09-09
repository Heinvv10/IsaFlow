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
  'read:practice',
  'write:practice',
  'read:payroll',
  'write:payroll',
  'write:post',
  'read:approvals',
  'write:approvals',
  'write:beneficiaries',
  'read:access',
  'read:audit',
  'write:audit',
  'write:controls',
  'write:locks',
  'read:payroll-sensitive',
  'offline_access',
] as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[number];
