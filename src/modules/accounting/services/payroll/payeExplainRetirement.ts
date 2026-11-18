/**
 * The retirement fund and annual-payment steps of the PAYE explanation (payeExplain.ts), moved out of it unchanged
 * (wave-6 AN, refactor(split)): the s11F deduction off the annual equivalent, and what comes off the annual payments.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { RETIREMENT_DEDUCTION_RATE } from './retirementFund';
import { getTaxYearConfig } from './taxTables';
import { annualisationFactorWords } from './annualisationFactor';
import { SOURCES, footed, pct, sourceFor, type ExplainStep } from './payrollExplainTypes';
import type { PayeExplainInput } from './payeExplain';

const r = (n: number) => formatMoney(n);

export function retirementStep(input: PayeExplainInput): ExplainStep {
  const { trace: t, taxYear } = input;
  return {
    key: 'paye.retirement', label: 'Less the retirement fund deduction off the annual equivalent', amount: t.offPeriodic,
    formula: 'the lesser of the deduction allowed a year and the annual equivalent (plus periodic donations a year)',
    source: sourceFor(SOURCES.retirement, taxYear),
    children: [
      {
        key: 'paye.retirement.allowed', label: 'Deduction allowed a year', amount: t.annualDeduction,
        formula: `the least of: contributions a year, ${pct(RETIREMENT_DEDUCTION_RATE)} of remuneration, the annual cap`,
        children: [
          {
            key: 'paye.retirement.annualised', label: 'Contributions a year', amount: t.annualisedContributions,
            formula: t.periods > 0 ? `to date × ${annualisationFactorWords(t.factor)} ÷ periods` : 'no periodic pay yet: taken as it stands',
            children: [{ key: 'paye.retirement.contributionsToDate', label: 'Contributions to date (4001, 4003, 4006, and the employer\'s 3817, 3825, 3828 deemed paid by the employee)', amount: t.contributionsToDate }],
          },
          {
            key: 'paye.retirement.rateLimit', label: `${pct(RETIREMENT_DEDUCTION_RATE)} of remuneration a year`, amount: t.shareOfRemuneration,
            formula: `${pct(RETIREMENT_DEDUCTION_RATE)} × ${r(t.deductionBase)}`,
            children: [
              { key: 'paye.retirement.base', label: 'Remuneration a year before the deduction (donations added back)', amount: t.deductionBase },
              { key: 'paye.retirement.rate', label: 'Share', amount: RETIREMENT_DEDUCTION_RATE, unit: 'percent' },
            ],
          },
          {
            key: 'paye.retirement.cap', label: 'Annual cap, on the annual-equivalent scale', amount: t.annualCap,
            formula: `${r(getTaxYearConfig(taxYear).retirementDeductionCap)} × (${annualisationFactorWords(t.factor)}) ÷ ${t.periodsInYear}`,
            children: [{ key: 'paye.retirement.statutoryCap', label: 'The s11F annual cap', amount: getTaxYearConfig(taxYear).retirementDeductionCap }],
          },
        ],
      },
      { key: 'paye.retirement.ceiling', label: 'The annual equivalent, plus periodic donations a year', amount: t.offPeriodicCeiling },
      {
        key: 'paye.retirement.recorded', label: 'Recorded on this line (to date, less what earlier lines recorded)', amount: input.retirementRecorded,
        note: 'The deduction this payslip and the IRP5 carry.',
      },
    ],
  };
}

/** Annual payments to date as the tax on them takes them: less the deduction and any donation that came off them. */
export function annualPaymentsStep(input: PayeExplainInput): ExplainStep {
  const { trace: t, taxYear } = input;
  const parts: ExplainStep[] = [footed({ key: 'paye.annualNow', label: 'This period', amount: t.annualNow }, [
    { key: 'paye.annualNow.paid', label: 'Paid this period', amount: input.annualBeforeDonation },
    ...(input.donationOffAnnual > 0 ? [{
      key: 'paye.annualNow.donation', label: 'Less the s18A donation larger than periodic pay', amount: -input.donationOffAnnual, source: sourceFor(SOURCES.donations, taxYear),
    }] : []),
  ])];
  parts.push({ key: 'paye.annualBefore', label: 'Earlier periods', amount: t.annualBefore });
  if (t.offAnnual > 0) {
    parts.push({
      key: 'paye.offAnnual', label: 'Less the retirement fund deduction taken off them', amount: -t.offAnnual, source: sourceFor(SOURCES.retirement, taxYear),
      formula: 'the least of these limits, never below nil',
      children: [
        {
          key: 'paye.offAnnual.deductionLeft', label: 'The deduction a year left after the annual equivalent\'s part over a year', amount: t.offAnnualLimits.deductionLeft,
          formula: `${r(t.annualDeduction)} − ${r(t.offPeriodic)} × ${t.periodsInYear} ÷ (${annualisationFactorWords(t.factor)})`,
        },
        { key: 'paye.offAnnual.annualPayments', label: 'The annual payments to date', amount: t.offAnnualLimits.annualPayments },
        { key: 'paye.offAnnual.contributionsLeft', label: 'Contributions to date, less the part off periodic pay to date', amount: t.offAnnualLimits.contributionsLeft },
        {
          key: 'paye.offAnnual.capLeft', label: 'The cap to date, less that part', amount: t.offAnnualLimits.capLeft,
          formula: `${r(t.capToDate)} − ${r(t.deductionOffPeriodicToDate)}`,
          children: [
            { key: 'paye.offAnnual.capToDate', label: `Cap to date (the s11F annual cap × periods ÷ ${t.periodsInYear})`, amount: t.capToDate },
            { key: 'paye.offAnnual.capPeriods', label: 'Periods for the cap (periodic pay or an annual payment)', amount: t.capPeriods, unit: 'count' },
            { key: 'paye.offAnnual.offPeriodicToDate', label: 'The deduction off periodic pay to date', amount: t.deductionOffPeriodicToDate },
          ],
        },
      ],
    });
  }
  if (t.donationSpill > 0) {
    parts.push({
      key: 'paye.donationSpill', label: 'Less the retirement deduction the donations left no periodic pay for', amount: -t.donationSpill,
      source: sourceFor(SOURCES.donations, taxYear),
    });
  }
  return footed({ key: 'paye.annualPayments', label: 'Annual payments to date (bonus and other 3605)', amount: t.annualAll, source: sourceFor(SOURCES.annualPayment, taxYear) }, parts);
}
