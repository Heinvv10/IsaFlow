/**
 * PAT scope vocabulary — ZERO imports (client-bundle safe).
 * The canonical list lives here so UI pages can render it without pulling
 * the pg-backed auth modules into the browser bundle; personalAccessTokens.ts
 * re-exports it for server-side consumers.
 */
export const PAT_SCOPES = [
  'read:invoices',
  'write:invoices',
  'read:bank-tx',
  'write:bank-tx',
  'write:journals',
  'write:accounts',
  'read:reports',
  'read:contacts',
  'read:vat',
  'read:practice',
  'write:practice',
  'write:post',
] as const;

export type PatScope = (typeof PAT_SCOPES)[number];
