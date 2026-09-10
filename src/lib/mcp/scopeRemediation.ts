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
 * The reply for a domain permission refusal. Only a missing TOKEN scope is
 * fixed by re-authorising; a role ceiling, a module override or an account
 * range is set by a company owner or admin, and re-consent would strip the scope
 * again (attenuateGrantedScopes), so telling that caller to re-authorise sends
 * them round in a loop.
 */
export function permissionRefusalMessage(permission: string,
  reason?: 'UNKNOWN_PERMISSION' | 'ROLE_CEILING' | 'MISSING_SCOPE' | 'MODULE_DENIED' | 'ENTITY_REQUIRED'): string {
  if (reason === 'MISSING_SCOPE') return insufficientScopeMessage(permission);
  if (reason === 'ROLE_CEILING') {
    return `Your role in this company does not allow ${permission}. Granting this connection again `
      + 'will not change that: a company owner or admin must perform the operation or change your role.';
  }
  if (reason === 'MODULE_DENIED') {
    return `A company owner or admin has restricted your access to this area, so ${permission} is `
      + 'denied to you even though this connection holds it. Ask an owner or admin to change your '
      + 'module permissions; granting the connection again will not.';
  }
  if (reason === 'ENTITY_REQUIRED') {
    return `Your ${permission} access is limited to specific accounts by a company owner or admin, `
      + 'and this operation falls outside them. Ask an owner or admin to widen that range.';
  }
  return `Current permissions do not allow this operation (${permission}).`;
}

/**
 * The reply for a scope the token does not hold. Names the scope so an operator
 * can match it to the grant screen, and appends the remedy where there is one.
 */
export function insufficientScopeMessage(scope: string): string {
  const remediation = SCOPE_REMEDIATION[scope as PatScope];
  const base = `Insufficient scope: this tool requires ${scope}.`;
  return remediation ? `${base} ${remediation}` : base;
}
