/**
 * The run page's knowledge of line result codes (PayrollRunWarnings), in a module of its own so a
 * census can hold BLOCKING_LINE_CODES to what the approval gate actually refuses on
 * (tests/integration/payrun-line-codes-census.int.test.ts).
 */

/** The group heading per code. An unknown code is headed "Other (CODE)", never one employee's message. */
export const GROUP_LABEL: Record<string, string> = {
  ETI_INDETERMINATE: 'ETI eligibility could not be determined — no ETI claimed',
  ETI_TABLE_UNCONFIRMED: 'ETI claimed on a table that is unconfirmed for pay periods after 31 March 2026 — verify before submitting',
  PAYE_ZERO_ON_TAXABLE_INCOME: 'Taxable income above the threshold but zero PAYE — verify tax number and directive',
  MISSING_TAX_NUMBER: 'No SARS tax number — PAYE cannot be calculated',
  INVALID_TAX_NUMBER_FORMAT: 'Tax number invalid — must be 10 digits',
  DUPLICATE_TAX_NUMBER: 'Tax number already used by another employee',
  INVALID_ID_NUMBER: 'ID number must be 13 digits',
  MISSING_BANK_DETAILS: 'No bank details — EFT payment will fail',
  DEDUCTIONS_EXCEED_PAY: 'Deductions and tax exceed pay — reduce the deductions, then recalculate',
  LOAN_INSTALMENT_EXCEEDS_PAY: 'Loan instalment exceeds pay — reduce or defer it, close the loan, or pay final pay first; then recalculate',
  LOAN_DEDUCTION_MISSING: 'Loan instalment not taken — no active LOAN deduction; add it under Setup → Pay Components, then recalculate',
  LOAN_FRINGE_NOT_RECORDED: 'Loan fringe benefit not recorded — add the 3801 earning under Setup → Pay Components, then recalculate',
  RECURRING_NEEDS_PRO_RATA: 'A recurring component starts after the 27th or ends before month end — needs a manual pro-rata: use Edit dates on the employee\'s Pay Components, then recalculate',
};

/** Codes whose message carries the employee's own figures (a loan, an amount): shown per employee. */
export const OWN_FIGURES: ReadonlySet<string> = new Set([
  'DEDUCTIONS_EXCEED_PAY', 'LOAN_INSTALMENT_EXCEEDS_PAY', 'LOAN_DEDUCTION_MISSING', 'LOAN_FRINGE_NOT_RECORDED',
  'RECURRING_NEEDS_PRO_RATA', // the component and its dates
]);

/** Line results the approval gate refuses on (payrollLineBlockers, payrollRecurringProRata): blocking, not warnings. */
export const BLOCKING_LINE_CODES: ReadonlySet<string> = new Set([
  'DEDUCTIONS_EXCEED_PAY', 'LOAN_DEDUCTION_MISSING', 'LOAN_INSTALMENT_EXCEEDS_PAY', 'LOAN_FRINGE_NOT_RECORDED',
  // payrollRecurringProRata.runProRataBlocker (the gate refuses a line carrying it, even once the row is fixed: recalculate).
  'RECURRING_NEEDS_PRO_RATA',
]);

/** Every code the page labels or treats specially. */
export const KNOWN_LINE_CODES: readonly string[] = [...new Set([...Object.keys(GROUP_LABEL), ...OWN_FIGURES, ...BLOCKING_LINE_CODES])];
