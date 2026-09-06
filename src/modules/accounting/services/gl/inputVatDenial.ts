/**
 * Input-tax denial on entertainment accounts — VAT Act s17(2)(a).
 *
 * SARS denies input tax on entertainment: food, beverages and hospitality,
 * whether the guest is staff or a client. Nothing in the posting paths knew
 * that, so every bank rule pointing at Staff Welfare carried
 * `vat_code = 'standard'` and each restaurant charge was split 15% exclusive
 * with the tax debited to VAT Input — R43,008.01 across 478 journals.
 *
 * `gl_accounts.vat_input_denied` is the marker, set per account from the Chart
 * of Accounts screen. It is DELIBERATELY NOT `default_vat_code`: that column
 * says what to default to, which is a different fact. `5800 Insurance Expense`
 * defaults to 'none' in production and is standard-rated and claimable, so
 * conflating the two blocked a legitimate claim.
 *
 * ADVISORY, NOT ENFORCED — with one exception
 * -------------------------------------------
 * s17(2)(a)(i) lets a vendor who continuously supplies entertainment for a
 * charge claim that input tax, and only the user knows whether that is them. So
 * on the interactive paths the flag drives a WARNING and the user's choice
 * stands: `shouldWarnOnVatCode` is what the screens ask.
 *
 * The exception is the rule auto-post sweep, where nobody is watching. There
 * `applyVatDenial` coerces to 'none' and the caller reports it, so an automated
 * run never invents a claim on a schedule. That is the one place this changes
 * what posts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';
import { applyNonSupplyGuard } from './nonSupplyVatGuard';
import type { NonSupplyReason } from './nonSupplyAccounts';

/** The vat code that claims no input tax. */
export const VAT_CODE_NONE = 'none';
/** The only code that claims input tax, and so the only one a denial bites on. */
export const VAT_CODE_STANDARD = 'standard';

/** Shown wherever a user is about to claim input tax on a flagged account. */
export const INPUT_VAT_DENIED_ADVICE =
  'Input tax on entertainment is denied (VAT Act s17(2)(a)). Claim it only if '
  + 'this business continuously supplies entertainment for a charge.';

export interface VatResolution {
  /** The code the journal must actually be posted with. */
  vatCode: string;
  /** True when the account's denial overrode what the caller asked for. */
  denied: boolean;
  /**
   * Set when the SECOND guard fired instead — the account is one on which no
   * supply can arise. A different statute from s17(2)(a) and a different
   * module (`nonSupplyVatGuard`); see the note on the resolver below.
   */
  nonSupplyReason?: NonSupplyReason;
}

/**
 * Does this combination warrant a warning? Pure, and the only thing the
 * interactive paths need — they never change the user's choice.
 */
export function shouldWarnOnVatCode(
  vatInputDenied: boolean | null | undefined,
  requestedVatCode: string | null | undefined,
): boolean {
  return Boolean(vatInputDenied) && (requestedVatCode || VAT_CODE_NONE) === VAT_CODE_STANDARD;
}

/**
 * Coerce a claim that no human approved. For UNATTENDED callers only — the rule
 * auto-post sweep. Interactive callers use `shouldWarnOnVatCode` and leave the
 * user's choice alone.
 *
 * Only `'standard'` is denied. s17(2)(a) denies INPUT TAX; it does not
 * un-zero-rate or un-exempt a supply, and coercing `'zero_rated'` to `'none'`
 * would strip `vat_type` off the contra line that VAT201 and the exceptions
 * reports read.
 */
export function applyVatDenial(
  vatInputDenied: boolean | null | undefined,
  requestedVatCode: string | null | undefined,
  context: Record<string, unknown> = {},
): VatResolution {
  const requested = requestedVatCode || VAT_CODE_NONE;
  if (!shouldWarnOnVatCode(vatInputDenied, requested)) {
    return { vatCode: requested, denied: false };
  }

  log.warn(
    'Input VAT denied on this account (s17(2)(a)) — posting the gross amount instead',
    { requestedVatCode: requested, ...context },
    'accounting',
  );
  return { vatCode: VAT_CODE_NONE, denied: true };
}

/** `applyVatDenial` for an unattended caller holding only an account id. */
export async function resolveVatCodeForAccount(
  companyId: string,
  glAccountId: string | null | undefined,
  requestedVatCode: string | null | undefined,
  context: Record<string, unknown> = {},
): Promise<VatResolution> {
  const requested = requestedVatCode || VAT_CODE_NONE;
  // Widened from `!== VAT_CODE_STANDARD` when the non-supply guard joined:
  // that one also bites on zero_rated, which still declares a supply value in
  // box 2. The denial guard below is unaffected — it only ever fires on
  // standard, so a zero_rated code costs one lookup and returns unchanged.
  if (!glAccountId || !claimsSomething(requested)) {
    return { vatCode: requested, denied: false };
  }

  const rows = (await sql`
    SELECT vat_input_denied, account_code, account_name
    FROM gl_accounts
    WHERE id = ${glAccountId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];

  const account = rows[0];
  const ctx = {
    companyId,
    glAccountId,
    accountCode: account?.account_code,
    accountName: account?.account_name,
    ...context,
  };

  // TWO GUARDS, TWO STATUTES, ONE LOOKUP. They are kept in separate modules on
  // purpose — s17(2)(a) denies a claim on a supply that really happened, while
  // nonSupplyVatGuard says no supply happened at all, and conflating those is
  // the mistake this file's header already warns about. What they share is the
  // account row, so the resolver chains them rather than paying for a second
  // SELECT. Denial runs first only because it is the narrower rule; both land
  // on 'none', so the order cannot change the posted code.
  const denial = applyVatDenial(Boolean(account?.vat_input_denied), requested, ctx);
  if (denial.denied) return denial;

  const nonSupply = applyNonSupplyGuard(
    account?.account_name === undefined || account?.account_name === null
      ? null : String(account.account_name),
    requested,
    { companyId, glAccountId, ...context },
  );
  return nonSupply.coerced
    ? { vatCode: nonSupply.vatCode, denied: false, nonSupplyReason: nonSupply.reason ?? undefined }
    : denial;
}

/** Does this code claim or declare anything a guard should look at? */
function claimsSomething(code: string): boolean {
  return code !== VAT_CODE_NONE && code !== 'no_vat' && code !== 'exempt';
}

/**
 * Batched form: one query for a whole rule sweep or split allocation, rather
 * than one per line. Returns the denial flag keyed by account id.
 */
export async function fetchVatDenialFlags(
  companyId: string,
  glAccountIds: string[],
): Promise<Map<string, boolean>> {
  const ids = [...new Set(glAccountIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const rows = (await sql`
    SELECT id, vat_input_denied
    FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
  `) as DbRow[];

  return new Map(rows.map((r) => [String(r.id), Boolean(r.vat_input_denied)]));
}
