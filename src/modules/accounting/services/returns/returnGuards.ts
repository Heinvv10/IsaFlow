/** Who may file or amend a return, and what counts as a written reason or reference (wave 5 L1b). */
import { ReturnRefusal } from './returnVersionTypes';

/** Owner/admin only, for the filing and the amend alike. */
const ACT_ROLES: readonly string[] = ['owner', 'admin', 'super_admin'];

/** Whitespace and zero-width or invisible characters; migration 971 holds the same set in its trigger. */
const INVISIBLE = /[\s\u00A0\u180E\u1680\u2000-\u200F\u2028-\u202F\u205F-\u2064\u3000\uFEFF]/g;

export function assertMayActOnReturns(role: string, what: 'file' | 'amend'): void {
  if (!ACT_ROLES.includes(role)) throw new ReturnRefusal(403, `Only an owner or admin can ${what} a return.`);
}

/** The trimmed text, or a 400 naming `what` when it holds nothing a person could read. */
export function visibleText(value: string, what: string): string {
  if (value.replace(INVISIBLE, '') === '') throw new ReturnRefusal(400, `${what} is required.`);
  return value.trim();
}
