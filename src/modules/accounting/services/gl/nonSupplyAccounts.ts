/**
 * What kind of account is this, for VAT purposes — the classifier.
 *
 * Lives in `gl/` and not in `reports/` because it answers a question about the
 * CHART OF ACCOUNTS, not about a report. Two consumers need it and they are on
 * opposite sides of the ledger: `reports/vatNonSupplyExceptions` reports lines
 * that already posted, and `gl/nonSupplyVatGuard` stops the next one. A third,
 * the bank screens, needs it in the browser — which is why this module is PURE
 * and imports no database client. Do not add one.
 *
 * The patterns are authored in POSIX because `vatNonSupplyExceptions`'s SQL is
 * what runs against the ledger; `toJsRegExp` translates for every JS caller.
 * Production evidence, limits and the ambiguous names are documented in that
 * file's header — read it before editing a pattern.
 */

/**
 * Why an account can never carry VAT. Defined HERE, beside the patterns that
 * assign it, and re-exported by `reports/vatExceptionsTypes` for the report
 * row type — so a new category cannot be added to one without the other.
 */
export type NonSupplyReason =
  | 'employment_cost'
  | 'tax_or_penalty'
  | 'distribution'
  | 'depreciation'
  | 'donation'
  | 'financial_service';

/**
 * VAT codes that make no claim, so carry no defect on a non-supply account.
 *
 * `exempt` is here and is load-bearing — but for ONE of the six categories.
 * Interest received and share/loan transactions are genuinely s12(a) exempt
 * supplies, and coding `financial_service` accounts `exempt` is the correct
 * treatment; without this exclusion the rule would flag every properly-coded
 * interest account in the platform (production has 2 such lines today, on
 * `4310 Interest Received`).
 *
 * For the other five categories `exempt` is NOT correct — salaries, taxes,
 * distributions and depreciation are OUT OF SCOPE, not exempt, and `no_vat`
 * is the right code. `exempt` on those positively asserts that a supply
 * occurred and was exempt, which in `getVATReturn` lands in output box 3 and
 * so distorts the s17(1) turnover apportionment ratio. The exclusion stays
 * whole anyway: `getVATReturn` only reads accounts subtyped `vat_input`,
 * `vat_output` or `tax`, so an `exempt` code on a salary EXPENSE account
 * reaches no box today, and production carries no such line. If that changes,
 * the fix is a narrower exclusion — `exempt` accepted only for
 * `financial_service` — not the removal of this constant.
 */
export const NON_CLAIMING_VAT_TYPES: readonly string[] = ['no_vat', 'exempt'];

/**
 * Ordered account-name patterns, first match wins.
 *
 * POSIX regex, matched case-insensitively against `gl_accounts.account_name`
 * by both `classifyNonSupplyAccount` below and the SQL at the bottom of this
 * file — they share these strings so the two cannot drift.
 *
 * Word-boundary anchors (`\m`, `\M`) on the short acronyms only: bare `paye`
 * would otherwise match inside longer words, while `salar` is deliberately a
 * stem so it takes "Salary" and "Salaries" both.
 */
export const NON_SUPPLY_PATTERNS: ReadonlyArray<{ reason: NonSupplyReason; pattern: string }> = [
  // Employment is excluded from "enterprise" (VAT Act s1), so no supply arises
  // on remuneration or on the statutory deductions that ride with it.
  { reason: 'employment_cost', pattern: 'salar|wage|payroll|\\mpaye\\M|\\muif\\M|\\msdl\\M|leave pay' },
  // Taxes, fines and penalties are imposed, not supplied.
  { reason: 'tax_or_penalty', pattern: 'income tax|provisional tax|\\mfines?\\M|penalt' },
  // A distribution to owners is not consideration for anything.
  { reason: 'distribution', pattern: 'dividend|drawings' },
  // An internal allocation with no counterparty and no transaction.
  { reason: 'depreciation', pattern: 'deprecia|amorti[sz]' },
  // Given without consideration, so outside the scope of VAT.
  { reason: 'donation', pattern: 'donation' },
  // Exempt financial services (VAT Act s12(a)): interest, and the issue,
  // holding or disposal of shares and loans.
  { reason: 'financial_service', pattern: 'interest|investment|\\mloans?\\M' },
];

/** The union of every pattern above — what the SQL filters on. */
export const NON_SUPPLY_PATTERN = NON_SUPPLY_PATTERNS.map((p) => p.pattern).join('|');

/**
 * Rewrite a POSIX pattern for JavaScript's regex engine.
 *
 * The patterns are authored for Postgres because the SQL is what runs against
 * the ledger. Postgres spells a word boundary `\m` (start), `\M` (end) and
 * `\y` (either); JavaScript spells all three `\b` — and, worse, treats `\m`
 * as an identity escape for a literal "m" rather than erroring, so an
 * untranslated pattern silently matches nothing. `\mpaye\M` in JS is the
 * literal string "mpayeM", which is how a PAYE account would have slipped
 * through the pure predicate while the SQL flagged it.
 */
export function toJsRegExp(posixPattern: string): RegExp {
  return new RegExp(posixPattern.replace(/\\[mMy]/g, '\\b'), 'i');
}

const COMPILED = NON_SUPPLY_PATTERNS.map(
  ({ reason, pattern }) => ({ reason, re: toJsRegExp(pattern) }),
);

/**
 * Why this account can never carry VAT, or null if it can.
 *
 * Pure, exported and tested directly, so the rule can be exercised with no
 * database and so a pattern change is visible in one place.
 */
export function classifyNonSupplyAccount(accountName: string): NonSupplyReason | null {
  for (const { reason, re } of COMPILED) {
    if (re.test(accountName)) return reason;
  }
  return null;
}


/** The vat code that claims nothing — what a coercion lands on. */
export const VAT_CODE_NONE = 'none';

/**
 * What the screen tells someone about to claim VAT here.
 *
 * One line per reason, and every reason must have one: the UI indexes this
 * directly, so a new category without copy renders an empty warning.
 */
export const NON_SUPPLY_ADVICE: Record<NonSupplyReason, string> = {
  employment_cost:
    'Employment is not a supply (VAT Act s1), so no VAT arises on remuneration '
    + 'or on the statutory deductions that ride with it.',
  tax_or_penalty:
    'Taxes, fines and penalties are imposed rather than supplied, so no VAT arises.',
  distribution:
    'A distribution to owners is not consideration for a supply, so no VAT arises.',
  depreciation:
    'Depreciation is an internal allocation with no counterparty, so no VAT arises.',
  donation:
    'A donation is given without consideration, so it falls outside the scope of VAT.',
  financial_service:
    'Interest and the issue, holding or disposal of shares and loans are exempt '
    + 'financial services (VAT Act s12(a)), so no input tax may be claimed.',
};

/** True when this code actually claims something, so a guard can bite on it. */
export function claimsVat(vatCode: string | null | undefined): boolean {
  const code = vatCode || VAT_CODE_NONE;
  return code !== VAT_CODE_NONE && !NON_CLAIMING_VAT_TYPES.includes(code);
}

/**
 * Should the screen warn about this combination, and why?
 *
 * Pure, and the only thing the attended paths need — they never change the
 * user's choice. Returns the reason so the caller can show the right advice,
 * or null for "nothing to say".
 */
export function shouldWarnOnNonSupply(
  accountName: string | null | undefined,
  requestedVatCode: string | null | undefined,
): NonSupplyReason | null {
  if (!accountName) return null;
  if (!claimsVat(requestedVatCode)) return null;
  return classifyNonSupplyAccount(accountName);
}

/** Two or three words for the screen, where the full advice is a tooltip. */
export const NON_SUPPLY_LABEL: Record<NonSupplyReason, string> = {
  employment_cost: 'Employment cost',
  tax_or_penalty: 'Tax or penalty',
  distribution: 'Owner distribution',
  depreciation: 'Depreciation',
  donation: 'Donation',
  financial_service: 'Exempt financial service',
};
