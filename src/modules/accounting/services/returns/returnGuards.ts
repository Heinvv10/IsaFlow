/** Who may file or amend a return, and what counts as a written reason or reference (wave 5 L1b). */
import { ReturnRefusal } from './returnVersionTypes';

/** Owner/admin only, for the filing and the amend alike. */
const ACT_ROLES: readonly string[] = ['owner', 'admin', 'super_admin'];

/** Whitespace and zero-width or invisible characters; migration 971 holds the SAME set in its trigger (keep the two in step). */
const INVISIBLE = /[\s\u00AD\u0085\u00A0\u034F\u115F-\u1160\u1680\u17B4-\u17B5\u180B-\u180F\u2000-\u200F\u2028-\u202F\u205F-\u206F\u2800\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E0FFF}]/gu;

export function assertMayActOnReturns(role: string, what: 'file' | 'amend'): void {
  if (!ACT_ROLES.includes(role)) throw new ReturnRefusal(403, `Only an owner or admin can ${what} a return.`);
}

/** The trimmed text, or a 400 naming `what` when it holds nothing a person could read. */
export function visibleText(value: string, what: string): string {
  if (value.replace(INVISIBLE, '') === '') throw new ReturnRefusal(400, `${what} is required.`);
  return value.trim();
}
