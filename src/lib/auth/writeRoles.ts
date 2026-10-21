/**
 * The roles that may write — owner, admin, manager. No imports, so a page can
 * use it to decide what to offer without pulling server code into the bundle;
 * withWriteAccess enforces the same list on the server.
 */
export const DEFAULT_WRITE_ROLES = ['owner', 'admin', 'manager'] as const;

export type WriteRole = (typeof DEFAULT_WRITE_ROLES)[number];

/** Whether a company role may write (and so approve payroll). Null — role not known yet — may not. */
export function canWrite(role: string | null | undefined): boolean {
  return (DEFAULT_WRITE_ROLES as readonly string[]).includes(role ?? '');
}

/** A token scope that lets it change data. */
export function isWriteScope(scope: string): boolean {
  return scope.startsWith('write:');
}

/**
 * The scopes a token minted for this role may not hold: every write scope, for a role that cannot
 * write (audit 2026-10-18 S-01: a viewer minted write:post and posted journals over MCP). The PAT
 * route and OAuth consent apply it at mint; the MCP registry's role fence applies the role at call.
 */
export function scopesRoleMayNotHold(role: string | null | undefined, scopes: readonly string[]): string[] {
  return canWrite(role) ? [] : scopes.filter(isWriteScope);
}
