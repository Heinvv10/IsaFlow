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

/**
 * The roles that may cancel an APPROVED purchase order (budgets P5-3 review r2): owner and admin. The cancel route's
 * `allowedRoles` and the PO page's button both read it.
 */
export const PO_CANCEL_ROLES = ['owner', 'admin'] as const;

/** Whether a company role may cancel an approved purchase order. */
export function canCancelApprovedPo(role: string | null | undefined): boolean {
  return (PO_CANCEL_ROLES as readonly string[]).includes(role ?? '');
}

/**
 * The roles that may change where payroll net pay is credited (Default Accounts' `payroll_net_pay` and the bank role's
 * `primary_bank`): owner and admin.
 * A manager may approve payroll, so one who could also redirect net pay could do both in a session (security review L1).
 */
export const PAYROLL_NET_PAY_ROLES = ['owner', 'admin'] as const;

/** Whether a company role may change where payroll net pay is credited. */
export function canSetPayrollNetPay(role: string | null | undefined): boolean {
  return (PAYROLL_NET_PAY_ROLES as readonly string[]).includes(role ?? '');
}

/**
 * The roles that may delete a fixed asset over MCP: owner and admin. It is the first path that removes an `assets` row
 * (security review 2026-11-13), so the manager role that the write fence admits is not enough.
 */
export const FIXED_ASSET_DELETE_ROLES = ['owner', 'admin'] as const;

/** Whether a company role may delete a fixed asset. Null — role not known — may not. */
export function canDeleteFixedAsset(role: string | null | undefined): boolean {
  return (FIXED_ASSET_DELETE_ROLES as readonly string[]).includes(role ?? '');
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
