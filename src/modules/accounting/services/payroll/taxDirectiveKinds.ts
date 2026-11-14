/**
 * The two families of SARS tax directive (PAYE-GEN-01-G21 (2027) Rev 1 p. 16, "The forms available are"). Pure; the
 * client form imports it too.
 *
 * - Lump sums (IRP3(a), the fund forms): paid once, at the directive's own figures, through a run's severance line or the
 *   stand-alone payment (taxDirectivePaymentService). Stored as lump_sum | retirement | severance | death.
 * - Regular pay (wave 5 DR): IRP3(b) "employees' tax to be deducted at a fixed percentage" and IRP3(c) "at a fixed
 *   amount" (G21 p. 16; Fourth Schedule para 11, G21 p. 17). They replace the tables on every period's remuneration
 *   while in force (directiveRegularPay.ts) and are never paid as a lump sum.
 *
 * `amount` (NOT NULL, migration 310) is 0 on a regular-pay directive: SARS states a rate or a tax amount on an IRP3(b) /
 * IRP3(c), not a remuneration figure, so nothing is stored there. The rate is `tax_rate` (a fraction) and the fixed
 * amount is `tax_amount` (rands a period).
 */

export const LUMP_SUM_DIRECTIVE_TYPES = ['lump_sum', 'retirement', 'severance', 'death'] as const;
export const REGULAR_PAY_DIRECTIVE_TYPES = ['fixed_percentage', 'fixed_amount'] as const;
export const DIRECTIVE_TYPES = [...LUMP_SUM_DIRECTIVE_TYPES, ...REGULAR_PAY_DIRECTIVE_TYPES] as const;

export type LumpSumDirectiveType = typeof LUMP_SUM_DIRECTIVE_TYPES[number];
export type RegularPayDirectiveType = typeof REGULAR_PAY_DIRECTIVE_TYPES[number];
export type DirectiveKind = typeof DIRECTIVE_TYPES[number];

export function isRegularPayDirectiveType(t: unknown): t is RegularPayDirectiveType {
  return (REGULAR_PAY_DIRECTIVE_TYPES as readonly unknown[]).includes(t);
}

export function isLumpSumDirectiveType(t: unknown): t is LumpSumDirectiveType {
  return (LUMP_SUM_DIRECTIVE_TYPES as readonly unknown[]).includes(t);
}
