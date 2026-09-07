/**
 * Which files decide a VAT claim, and which of those go through a guard.
 *
 * WHY THIS GATE EXISTS. Four separate code paths posted a VAT claim nobody
 * reviewed, and each was found by a different accident: the bank-rule sweep by
 * writing the feature, the confidence gate by a blind reviewer, the provisional
 * import poster by chasing a question put to that reviewer, and the MCP bulk
 * allocation tool — which had posted ALL 35 of the non-supply VAT lines in
 * production — by finally asking the ledger `posting_agent` instead of
 * assuming. Four discoveries, four different routes, none of them systematic.
 *
 * The search that would have found all four at once is the one below: a file
 * that computes or forwards a VAT claim must go through
 * `gl/ruleVatResolution` (or the denial funnel it wraps), or be listed as an
 * ATTENDED path with a reason. This turns "a reviewer notices the next one"
 * into a build failure.
 *
 * IMPORTS, NOT MENTIONS. A file satisfies the gate by IMPORTING a guard, never
 * by naming one in a comment — `bankAllocationService` has the funnel all over
 * its prose explaining why it deliberately does not call it, and a substring
 * check would read that as compliance. That is the source-text-assertion trap
 * this repo has been bitten by before.
 */

/**
 * Constants that mean the file is doing VAT arithmetic of its own. Matched as
 * a SUFFIX/PREFIX too — `SA_VAT_RATE`, `DEFAULT_VAT_RATE` and `SA_VAT_RATE_PCT`
 * are all in use, and an exact-word pattern silently missed three files.
 */
const RATE_CONSTANTS = /\b\w*VAT_RATE\w*\b/;

/** Writing a claiming code onto a journal line, rather than passing one on. */
const CLAIMING_LITERAL = /\b(vatType|vat_type)\s*:\s*'(standard|zero_rated)'/;

/** Handing a vat code to the poster that deliberately enforces nothing. */
const ALLOCATE_CALL = /\ballocateTransaction\s*\(/;

/**
 * Modules that resolve a claim against the two statutes. Matched on the import
 * SPECIFIER so a mention in prose cannot satisfy the gate.
 */
const GUARD_IMPORT =
  /^\s*import\s[\s\S]*?from\s+['"][^'"]*(ruleVatResolution|inputVatDenial|allocationVatGuard)['"]/m;

export type VatDecisionKind = 'rate_constant' | 'claiming_literal' | 'allocate_call';

export interface VatGuardFinding {
  /** Why the file is in scope. */
  kinds: VatDecisionKind[];
  /** True when it imports one of the guard modules. */
  guarded: boolean;
}

/** Does this source decide or forward a VAT claim, and does it guard? */
export function inspectVatGuardCoverage(source: string): VatGuardFinding | null {
  const withoutComments = stripComments(source);
  const kinds: VatDecisionKind[] = [];
  if (RATE_CONSTANTS.test(withoutComments)) kinds.push('rate_constant');
  if (CLAIMING_LITERAL.test(withoutComments)) kinds.push('claiming_literal');
  if (ALLOCATE_CALL.test(withoutComments)) kinds.push('allocate_call');
  if (kinds.length === 0) return null;
  return { kinds, guarded: GUARD_IMPORT.test(source) };
}

/**
 * Comments are stripped before looking for the DECISION, so a file explaining
 * the rule is not accused of breaking it — the same reason the guard check
 * reads imports. Imports are matched against the ORIGINAL source, because a
 * naive strip can eat a string containing `//` and take an import with it.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}
