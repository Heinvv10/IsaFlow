/**
 * The PAYE explanation of a line (wave 5 EX-core): the cumulative method's steps as payeCumulative's trace holds them,
 * the tax status treatment (TS-b), and a directive's PAYE. Pure; it arranges the engine's figures and computes none
 * (a total's "Not below nil" part, `footed`, is the one difference it states). Formulas are text; amounts are the engine's.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { ADDITIONAL_MEDICAL_MTC_MULTIPLE, ADDITIONAL_MEDICAL_RATE, type AnnualTaxAfterCredits } from './payeEngine';
import type { CumulativePayeTrace } from './payeCumulative';
import type { EmploymentClass } from './employmentTerms';
import { earningStep } from './earningExplain';
import type { EarningPart } from './payrollLineAccumulate';
import { RETIREMENT_DEDUCTION_RATE } from './retirementFund';
import { getTaxYearConfig } from './taxTables';
import { NON_STANDARD_RATE, type PayeTreatment } from './taxStatusTreatment';
import { SOURCES, footed, pct, sourceFor, type ExplainStep, type FigureExplanation } from './payrollExplainTypes';

export interface PayeExplainInput {
  taxYear: number;
  treatment: PayeTreatment;
  classification: { kind: EmploymentClass; reason: string };
  /** Periodic taxable pay before the s18A donation came off (the accumulator's, after a clawback; may be negative). */
  periodicBeforeDonation: number;
  /** The earnings as the totals took them (the taxable periodic ones add up to it), and a negative annual payment moved into it (or 0). */
  earningParts: EarningPart[];
  clawback: number;
  /** This line's medical scheme fees (the credits' fees): the employee's 4005 deductions plus the employer's 3810 deemed paid (FB). */
  medicalFees: { total: number; employee: number; employer: number };
  /** This period's annual payments before the donation (nil after a clawback took them into periodic pay). */
  annualBeforeDonation: number;
  /** The s18A deduction allowed on this line, and the part of it larger than periodic pay, off the annual payments (payrollLinePaye). */
  donationDeduction: number;
  donationOffAnnual: number;
  /** The final costing's trace (after the donation). */
  trace: CumulativePayeTrace;
  /** The retirement fund deduction this line records (payroll_run_lines.retirement_deduction). */
  retirementRecorded: number;
  /** Taxable income less the retirement deduction: what a flat rate is on; and the two taxable figures it is made of. */
  balanceOfRemuneration: number;
  regularTaxable: number;
  annualTaxable: number;
  split: { regular: number; annualPayment: number; directive: number };
  paye: number;
  /** A regular-pay directive's own steps (directiveExplain, DR): used in place of the tables / flat-rate steps. */
  directiveSteps?: ExplainStep[];
}

const r = (n: number) => formatMoney(n);

/** Tax for a year on one income: the bracket, the rebates and the medical credits, as the engine applied them. */
function taxBlock(key: string, label: string, t: AnnualTaxAfterCredits, taxYear: number): ExplainStep {
  const b = t.bracket;
  const lower = b.from - 1;
  const children: ExplainStep[] = [
    { key: `${key}.income`, label: 'Annual income taxed', amount: t.annualTaxableIncome },
    {
      key: `${key}.grossTax`, label: `Tax on it: the ${pct(b.rate)} bracket`, amount: t.grossAnnualTax,
      formula: `${r(b.baseTax)} + ${pct(b.rate)} × (${r(t.annualTaxableIncome)} − ${r(lower)})`,
      source: sourceFor(SOURCES.rates, taxYear),
      children: [
        { key: `${key}.bracket.baseTax`, label: 'Tax on the bracket below', amount: b.baseTax },
        { key: `${key}.bracket.rate`, label: 'Bracket rate', amount: b.rate, unit: 'percent' },
        { key: `${key}.bracket.lower`, label: 'Bracket starts above', amount: lower },
      ],
    },
    footed({
      key: `${key}.rebates`, label: 'Less the rebates', amount: t.rebates, source: sourceFor(SOURCES.rates, taxYear),
      note: `Rebate age ${t.ageAtPeriodEnd} at the end of the tax year (65 adds the secondary rebate, 75 the tertiary).`,
    }, [
      { key: `${key}.rebates.primary`, label: 'Primary rebate', amount: t.rebateParts.primary },
      { key: `${key}.rebates.secondary`, label: 'Secondary rebate (65 and older)', amount: t.rebateParts.secondary },
      { key: `${key}.rebates.tertiary`, label: 'Tertiary rebate (75 and older)', amount: t.rebateParts.tertiary },
    ]),
  ];
  if (t.medicalCredits > 0) {
    children.push({
      key: `${key}.medicalCredits`, label: 'Less the medical scheme fees tax credit (a year)', amount: t.medicalCredits,
      note: `${t.monthlyMedicalBeneficiaries} beneficiar${t.monthlyMedicalBeneficiaries === 1 ? 'y' : 'ies'}, × 12 months; it cannot take the tax below nil.`,
      source: sourceFor(SOURCES.medicalCredits, taxYear),
    });
  }
  if (t.additionalMedicalCredits > 0) {
    children.push({
      key: `${key}.additionalMedicalCredits`, label: 'Less the additional medical expenses tax credit (65 and older)',
      amount: t.additionalMedicalCredits,
      formula: `${pct(ADDITIONAL_MEDICAL_RATE)} × (${r(t.annualMedicalSchemeFees)} fees a year − ${ADDITIONAL_MEDICAL_MTC_MULTIPLE} × ${r(t.medicalCredits)})`,
      source: sourceFor(SOURCES.additionalMedical, taxYear),
    });
  }
  children.push({ key: `${key}.annualTax`, label: 'Tax for the year (never below nil)', amount: t.annualTax });
  return { key, label, amount: t.annualTax, children };
}

function retirementStep(input: PayeExplainInput): ExplainStep {
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
            formula: t.periods > 0 ? 'to date × 12 ÷ periods' : 'no periodic pay yet: taken as it stands',
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
          { key: 'paye.retirement.cap', label: 'Annual cap', amount: getTaxYearConfig(taxYear).retirementDeductionCap },
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
function annualPaymentsStep(input: PayeExplainInput): ExplainStep {
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
        { key: 'paye.offAnnual.deductionLeft', label: 'The deduction a year left after the annual equivalent', amount: t.offAnnualLimits.deductionLeft },
        { key: 'paye.offAnnual.annualPayments', label: 'The annual payments to date', amount: t.offAnnualLimits.annualPayments },
        { key: 'paye.offAnnual.contributionsLeft', label: 'Contributions to date, less the part off periodic pay to date', amount: t.offAnnualLimits.contributionsLeft },
        {
          key: 'paye.offAnnual.capLeft', label: 'The cap to date, less that part', amount: t.offAnnualLimits.capLeft,
          formula: `${r(t.capToDate)} − ${r(t.deductionOffPeriodicToDate)}`,
          children: [
            { key: 'paye.offAnnual.capToDate', label: 'Cap to date (the annual cap × periods ÷ 12)', amount: t.capToDate },
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

function tablesSteps(input: PayeExplainInput): ExplainStep[] {
  const { trace: t, taxYear } = input;
  if (!t.paid) {
    return [{ key: 'paye.unpaid', label: 'No periodic pay and no annual payment this period', amount: 0, note: 'The tables take nothing in a period with no pay.' }];
  }
  const steps: ExplainStep[] = [
    footed({ key: 'paye.regularTaxable', label: 'Taxable pay this period', amount: t.regularTaxable }, [
      footed({ key: 'paye.periodicBeforeDonation', label: 'Taxable periodic pay', amount: input.periodicBeforeDonation }, [
        ...input.earningParts.filter((p) => p.taxable && p.treatment === 'periodic').map((p, i) => earningStep(`paye.periodic.${i}`, p)),
        ...(input.clawback < 0 ? [{ key: 'paye.periodic.clawback', label: 'Less a negative annual payment (a bonus clawback)', amount: input.clawback }] : []),
      ]),
      // Signed: a negative deduction takes back an earlier line's donation the year to date no longer allows (s18aDonation).
      ...(input.donationDeduction !== 0 ? [{
        key: 'paye.donation', amount: -input.donationDeduction, source: sourceFor(SOURCES.donations, taxYear),
        label: input.donationDeduction > 0 ? 'Less the s18A donation allowed' : 'Plus an earlier s18A donation taken back (no longer allowed to date)',
      }] : []),
    ]),
    footed({ key: 'paye.periodicToDate', label: 'Taxable pay to date this tax year', amount: t.periodicToDate }, [
      { key: 'paye.ytdPeriodicTaxable', label: 'Earlier periods', amount: t.ytdPeriodicTaxable },
      { key: 'paye.thisPeriod', label: 'This period', amount: t.regularTaxable },
    ]),
    {
      key: 'paye.periods', label: t.hasPeriodic ? 'Periods paid, this one included' : 'Periods paid (this period has no periodic pay, so it does not count)',
      amount: t.periods, unit: 'count',
    },
    {
      key: 'paye.annualEquivalent', label: 'Annual equivalent', amount: t.annualEquivalent,
      formula: t.periods > 0 ? `${r(t.periodicToDate)} × 12 ÷ ${t.periods}` : 'no periodic pay to date: nil', source: sourceFor(SOURCES.annualEquivalent, taxYear),
      note: 'IsaFlow taxes the year to date (the cumulative method, a business decision of 2026-10-22): with the same pay every month it equals the SARS tables; a mid-year change is spread over the rest of the year.',
    },
  ];
  if (input.medicalFees.total !== 0) {
    steps.push(footed({
      key: 'paye.medicalFees', label: 'Medical scheme fees this period (for the medical credits)', amount: input.medicalFees.total,
      note: 'With the earlier periods\' fees, taken a year (× 12 ÷ periods) inside the tax for the year below.', source: sourceFor(SOURCES.additionalMedical, taxYear),
    }, [
      { key: 'paye.medicalFees.employee', label: 'Deducted from the employee (4005)', amount: input.medicalFees.employee },
      ...(input.medicalFees.employer !== 0 ? [{
        key: 'paye.medicalFees.employer', label: 'Paid by the employer (3810), deemed paid by the employee', amount: input.medicalFees.employer,
        source: sourceFor(SOURCES.employerMedical, taxYear),
      }] : []),
    ]));
  }
  if (t.annualDeduction > 0 || t.contributionsToDate > 0) steps.push(retirementStep(input));
  steps.push({ key: 'paye.taxedAnnualEquivalent', label: 'Annual equivalent taxed', amount: t.taxedAnnualEquivalent, formula: 'annual equivalent − the deduction off it (never below nil)' });
  steps.push(taxBlock('paye.atAE', 'Tax for the year on the annual equivalent', t.atAE, taxYear));
  if (t.annualAll > 0) {
    steps.push(annualPaymentsStep(input));
    steps.push(taxBlock('paye.atAll', 'Tax for the year with the annual payments', t.atAll, taxYear));
    if (t.annualEarlier > 0) {
      steps.push({ key: 'paye.annualEarlier', label: 'Earlier annual payments, less what came off them', amount: t.annualEarlier });
      steps.push(taxBlock('paye.atEarlier', 'Tax for the year with the earlier annual payments only', t.atEarlier, taxYear));
    }
  }
  steps.push({
    key: 'paye.liability', label: 'Tax due for the year to date', amount: t.liability,
    formula: `${r(t.atAE.annualTax)} × ${t.periods} ÷ 12${t.annualAll > 0 ? ` + (${r(t.atAll.annualTax)} − ${r(t.atAE.annualTax)})` : ''}`,
  });
  steps.push({ key: 'paye.ytdTablePaye', label: 'Less PAYE already deducted this tax year (tables)', amount: t.ytdTablePaye });
  steps.push({ key: 'paye.due', label: 'PAYE this period from the tables', amount: t.due, formula: 'due to date − already deducted, rounded to the cent, never below nil' });
  if (t.annualAll > 0) {
    steps.push({ key: 'paye.annualPart', label: 'Of which on the annual payment', amount: input.split.annualPayment, formula: 'the lesser of PAYE this period and the tax the annual payment added' });
    steps.push({ key: 'paye.regularPart', label: 'Of which on regular pay', amount: input.split.regular });
  }
  return steps;
}

function treatmentStep(input: PayeExplainInput): ExplainStep {
  const { treatment, classification, taxYear } = input;
  if (treatment === 'none') {
    return { key: 'paye.treatment', label: 'Independent contractor: no PAYE', amount: null, note: classification.reason, source: sourceFor(SOURCES.contractor, taxYear) };
  }
  if (treatment === 'flat_25') {
    return { key: 'paye.treatment', label: 'Non-standard employment: a flat rate, not the tables', amount: null, note: classification.reason, source: sourceFor(SOURCES.nonStandard, taxYear) };
  }
  return {
    key: 'paye.treatment', label: 'Taxed on the SARS tables', amount: null, note: classification.reason,
    ...(classification.kind === 'undetermined' ? { status: 'unverified' as const } : {}),
  };
}

export function explainPaye(input: PayeExplainInput): FigureExplanation {
  const steps: ExplainStep[] = input.directiveSteps ? [...input.directiveSteps] : [treatmentStep(input)];
  if (!input.directiveSteps && input.treatment === 'tables') steps.push(...tablesSteps(input));
  if (!input.directiveSteps && input.treatment === 'flat_25') {
    steps.push(footed({ key: 'paye.balance', label: 'Balance of remuneration (after allowed deductions)', amount: input.balanceOfRemuneration }, [
      { key: 'paye.balance.periodic', label: 'Taxable pay this period (after any s18A donation)', amount: input.regularTaxable },
      { key: 'paye.balance.annual', label: 'Annual payments this period', amount: input.annualTaxable },
      { key: 'paye.balance.retirement', label: 'Less the retirement fund deduction recorded on this line', amount: -input.retirementRecorded },
    ]));
    steps.push({ key: 'paye.flatRate', label: 'Flat rate', amount: NON_STANDARD_RATE, unit: 'percent' });
    steps.push({ key: 'paye.flat', label: 'PAYE at the flat rate', amount: input.split.regular, formula: `${pct(NON_STANDARD_RATE)} × ${r(input.balanceOfRemuneration)}, rounded to the cent, never below nil` });
  }
  if (input.split.directive !== 0) {
    steps.push({ key: 'paye.directive', label: 'Plus PAYE on a lump sum as SARS directed', amount: input.split.directive, source: sourceFor(SOURCES.directive, input.taxYear) });
  }
  const undetermined = input.classification.kind === 'undetermined';
  return {
    figure: 'paye', title: 'How PAYE was calculated', steps, result: input.paye, resultLabel: 'PAYE this period',
    ...(undetermined ? { caution: `The employment class could not be determined, so the tables were applied: ${input.classification.reason}` } : {}),
  };
}
