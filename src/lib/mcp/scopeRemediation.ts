/**
 * What a caller is told when its token lacks a tool's scope.
 *
 * THE MESSAGE IS THE ENTIRE USER EXPERIENCE OF A NEWLY ADDED SCOPE. Every token
 * minted before a scope existed lacks it, so every existing pilot connector
 * hits this on its first call to the new tool. "Insufficient scope: this tool
 * requires write:contacts" is accurate and useless — the person driving the
 * agent does not know that a scope is something they grant, or where. And
 * answering with the shared NOT_FOUND would be worse still: it reads as a
 * missing record and sends them looking for data.
 *
 * So a scope carries a remediation line saying what to DO, in the words the
 * consent screen uses. The map is keyed by scope rather than by tool because
 * the remedy is a property of the grant, not of the tool that noticed.
 *
 * This does NOT leak anything: which scopes exist is public (they are listed on
 * the consent screen and in the PAT minting UI), and the message says nothing
 * about whether any data exists.
 */
import type { PatScope } from '@/lib/auth/patScopes';

/**
 * Scopes whose absence needs more than the generic line — in practice, any
 * scope added after tokens were already in the field. Add an entry in the same
 * PR that adds the scope; a test asserts every key here is a real scope, so a
 * typo cannot sit silently never firing.
 */
export const SCOPE_REMEDIATION: Partial<Record<PatScope, string>> = {
  'write:contacts': 'This connection cannot create or edit customers and suppliers. '
    + 'write:contacts was added after this connection was authorised, so re-authorise the '
    + 'connector (or mint a new personal access token) and include "Write contacts" — the grant '
    + 'that covers creating and editing customers and suppliers, including supplier banking '
    + 'details. Existing permissions are unaffected and nothing else needs to change.',
  // lock_vat_period and mark_vat_declared_elsewhere moved off write:post onto
  // this dedicated scope (item 10, VAT-gaps) — every connection authorised
  // before this change lacks it, even ones that already hold write:post.
  'write:vat': 'This connection cannot lock a VAT period or clear a VAT pre-filing exception. '
    + 'write:vat was added after this connection was authorised (previously covered, less honestly, '
    + 'by write:post), so re-authorise the connector (or mint a new personal access token) and '
    + 'include "Write VAT controls" — the grant that covers locking a VAT period as filed and '
    + 'clearing a VAT pre-filing exception with a reason. Existing permissions are unaffected and '
    + 'nothing else needs to change.',
};

/**
 * The reply for a scope the token does not hold. Names the scope so an operator
 * can match it to the grant screen, and appends the remedy where there is one.
 */
export function insufficientScopeMessage(scope: string): string {
  const remediation = SCOPE_REMEDIATION[scope as PatScope];
  const base = `Insufficient scope: this tool requires ${scope}.`;
  return remediation ? `${base} ${remediation}` : base;
}
