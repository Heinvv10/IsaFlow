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
