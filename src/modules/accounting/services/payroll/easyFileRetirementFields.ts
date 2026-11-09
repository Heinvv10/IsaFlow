/**
 * The employee's retirement fund contributions on an e@syFile employee record
 * (PAYE 4c). SARS BRS PAYE Employer Reconciliation V25.3.0 (Jun-26): 4001
 * pension and 4003 provident (p. 101), 4006 retirement annuity (p. 102), each
 * the "total ... contributions paid and 'deemed paid' by employee"; N15, cents
 * omitted, no negatives, and a code with no value is not reported (p. 53-54).
 * The whole contributions, not the deduction the PAYE allowed (SARS
 * PAYE-GEN-01-G21 (2027) p. 11). The 'deemed paid' part, an employer's
 * contribution taxed as a 3817 / 3825 / 3828 benefit and reported beside
 * 4472 / 4473 / 4475 (BRS p. 54, 103), is PAYE 4b and not supported.
 * 4030 (p. 102): donations deducted from remuneration and paid over by the employer, reported in full, "not only the
 * allowable portion" (G21 (2027) p. 11). 4497 (p. 57): the total of every 40xx / 44xx / 45xx value on the record,
 * mandatory when any is completed and absent when none is; after the deduction codes, before 4101 / 4102.
 */

import { formatField } from './easyFileFields';

/** The year's contributions by code (deductions coded 4001 / 4003 / 4006; payrollRetirementRecord). */
export interface RetirementContributions {
  pension4001: number;
  provident4003: number;
  annuity4006: number;
  /** Donations (4030) deducted in the year, whatever PAYE allowed of them; a net negative reports nothing. */
  donations4030: number;
}

const field = (code: number, amount: number): string | null => (Math.floor(amount) > 0 ? formatField(code, amount, 'N') : null);

/** 4001 and 4003 (before 4005) and 4006 (after it), so the record stays in code order; none without a value. */
export function retirementFieldLines(r: RetirementContributions | undefined): { beforeMedical: (string | null)[]; afterMedical: (string | null)[] } {
  if (!r) return { beforeMedical: [], afterMedical: [] };
  return {
    beforeMedical: [field(4001, r.pension4001), field(4003, r.provident4003)],
    afterMedical: [field(4006, r.annuity4006), field(4030, r.donations4030)],
  };
}

const DEDUCTION_CODE = /^4[045]\d\d$/;

/** The record with 4497 (the sum of its emitted 40xx / 44xx / 45xx values) in code order; unchanged when none. */
export function withDeductionTotal(record: string[]): string[] {
  let last = -1;
  let firstAbove = -1;
  let total = 0;
  record.forEach((l, i) => {
    const [code, value] = l.split(',');
    if (code === '4497' || !DEDUCTION_CODE.test(code ?? '')) return;
    total += Number(value);
    // After the last code below 4497; with none, before the first above it (4582, an information code).
    if (Number(code) < 4497) last = i;
    else if (firstAbove < 0) firstAbove = i;
  });
  const at = last >= 0 ? last + 1 : firstAbove;
  return at < 0 ? record : [...record.slice(0, at), `4497,${Math.floor(total)}`, ...record.slice(at)];
}
