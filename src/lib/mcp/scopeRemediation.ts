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
import type { PermissionReason } from '@/lib/auth/effectivePermissionPolicy';

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
  // Four tools (close_fiscal_period, reopen_fiscal_period, year_end_close,
  // lock_vat_period) moved to this scope after connections were authorised.
  'write:locks': 'This connection cannot close, reopen or lock accounting periods or file a VAT '
    + 'period lock. write:locks is an opt-in grant: re-authorise the connector (or mint a new '
    + 'personal access token) and tick "Manage accounting locks". Owners and admins can use it '
    + 'unless a locks module override denies it to them; a manager needs an explicit locks module '
    + 'override; a viewer cannot hold it. Existing permissions are unaffected.',
  'write:bank-tx': 'This connection cannot allocate, settle or post bank transactions. '
    + 'Re-authorise the connector (or mint a new personal access token) and include "Write bank '
    + 'transactions" — the grant that covers allocating bank lines and moving cash through a '
    + 'payment. Settling an invoice also needs write:invoices ("Write invoices"). Existing '
    + 'permissions are unaffected.',
};

/**
 * The reply for a domain permission refusal. Only a missing TOKEN scope is fixed
 * by granting the connection again. A role ceiling, a module permission or an
 * account-range/restriction constraint is set per person by a company owner or
 * admin, and re-granting the connection changes none of them — so that caller
 * must not be told to re-authorise. A caller missing both a scope and a module
 * grant gets the scope reply first and, once re-authorised, this one.
 */
export function permissionRefusalMessage(permission: string, reason?: PermissionReason): string {
  if (reason === 'MISSING_SCOPE') return insufficientScopeMessage(permission);
  if (reason === 'ROLE_CEILING') {
    return `Your role in this company does not allow ${permission}. Granting this connection again `
      + 'will not change that: a company owner or admin must perform the operation or change your role.';
  }
  if (reason === 'MODULE_DENIED') {
    // Either an explicit override denies it or, for a permission a manager
    // needs granted explicitly, none was ever given: both are "not granted".
    return `${permission} has not been granted to you in this company's module permissions, even though `
      + 'this connection holds the scope. Ask a company owner or admin to grant it to you; granting the '
      + 'connection again will not.';
  }
  if (reason === 'ENTITY_REQUIRED') {
    // A constrained override (account range or any other restriction) refuses
    // every operation it cannot check entity by entity, so widening it does not
    // help: only removing it does.
    return `Your ${permission} access carries an account-range or other restriction set by a company `
      + 'owner or admin, and this operation cannot be checked against it. Ask an owner or admin to '
      + 'remove that restriction for you.';
  }
  return `Current permissions do not allow this operation (${permission}).`;
}

/** The reply to any approval-required refusal, preview or live. */
export const OPERATION_APPROVAL_REQUIRED_REPLY =
  'An independent approval is required for this operation under the company\'s approval policy. '
  + 'Request one with request_operation_approval, then retry with its approval once it is decided. '
  + 'Nothing was posted.';

/**
 * The reply for a scope the token does not hold. Names the scope so an operator
 * can match it to the grant screen, and appends the remedy where there is one.
 */
export function insufficientScopeMessage(scope: string): string {
  const remediation = SCOPE_REMEDIATION[scope as PatScope];
  const base = `Insufficient scope: this tool requires ${scope}.`;
  return remediation ? `${base} ${remediation}` : base;
}
