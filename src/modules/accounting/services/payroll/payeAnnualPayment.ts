/**
 * How an earning is taxed, by its SARS source code (audit 2026-10-18 P3). The
 * annual-payment method itself is in payeCumulative.ts (PAYE 4a follow-ups
 * G4), on top of the cumulative periodic tax.
 */

/**
 * How PAYE treats an earning, by its SARS source code (audit 2026-10-18 P3,
 * decided 2026-10-20: classification by code, no new column):
 *   'annual'   — 3605, annual payment (G21 p. 32: "Reflect under code 3605").
 *   'lump_sum' — 39xx, the lump-sum codes (SARS BRS PAYE Employer
 *                Reconciliation V25.2.0, §6.4 "Lump sum codes", 3901–3926 and
 *                their foreign-service twins 3951–3957). Taxed only at the
 *                figures on a SARS directive, never by the tables.
 *   'periodic' — every other code, and no code: taxed cumulatively (payeCumulative).
 */
export type PayeTreatment = 'periodic' | 'annual' | 'lump_sum';

/**
 * A SARS source code as PAYE classifies it: ASCII space, tab, CR and LF stripped
 * from both ends, nothing else. The SQL readers that classify stored breakdowns
 * (payrollRunDirectiveClaim, payrollSeveranceDirective, payrollLumpSumFiling)
 * strip exactly the same set — regexp_replace(code, '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g')
 * — so the calculator and the approval gate can never disagree about a code.
 * (String.prototype.trim strips every Unicode space and SQL btrim only ' '.)
 */
export function normaliseSarsCode(code: string | null | undefined): string {
  return (code ?? '').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
}

export function payeTreatment(sarsSourceCode: string | null | undefined): PayeTreatment {
  const code = normaliseSarsCode(sarsSourceCode);
  if (code === '3605') return 'annual';
  if (/^39\d\d$/.test(code)) return 'lump_sum';
  return 'periodic';
}
