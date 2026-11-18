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
import { annualisationFactorWords } from './annualisationFactor';
import { annualPaymentsStep, retirementStep } from './payeExplainRetirement';
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

const creditsUsed = (a: AnnualTaxAfterCredits) => a.medicalCreditUsed + a.additionalMedicalCreditUsed;

/** The annual equivalent's part of the liability: tax after rebates × n ÷ F, less the credits it used × n ÷ 12. */
function liabilityAE(t: CumulativePayeTrace): string {
  const f = annualisationFactorWords(t.factor);
  const c = creditsUsed(t.atAE);
  if (c <= 0) return `${r(t.atAE.annualTax)} × ${t.periods} ÷ (${f})`;
  return `(${r(t.atAE.annualTax + c)} × ${t.periods} ÷ (${f}) − ${r(t.creditsOnAEToDate)})`;
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
      key: 'paye.annualisationFactor', label: 'Periods in a year (the annualisation factor)', amount: t.factor, unit: 'count',
      formula: annualisationFactorWords(t.factor), source: SOURCES.annualisationFactor,
      note: 'Days-based, as Sage Payroll annualises a month (365 days ÷ 30.4166), not the × 12 of the SARS guide: a few cents a year apart.',
    },
    {
      key: 'paye.periodsInYear', label: 'Statutory periods in a year (for the s11F cap and the medical credits)', amount: t.periodsInYear, unit: 'count',
      note: 'The cap to date and the medical credits are period ratios the statute fixes: × periods ÷ this, never more than a year\'s worth.',
    },
    {
      key: 'paye.annualEquivalent', label: 'Annual equivalent', amount: t.annualEquivalent,
      formula: t.periods > 0 ? `${r(t.periodicToDate)} × ${annualisationFactorWords(t.factor)} ÷ ${t.periods}` : 'no periodic pay to date: nil',
      source: sourceFor(SOURCES.annualEquivalent, taxYear),
      note: 'IsaFlow taxes the year to date (the cumulative method, a business decision of 2026-10-22): with the same pay every month it is within cents of the SARS tables; a mid-year change is spread over the rest of the year.',
    },
  ];
  if (input.medicalFees.total !== 0) {
    steps.push(footed({
      key: 'paye.medicalFees', label: 'Medical scheme fees this period (for the medical credits)', amount: input.medicalFees.total,
      note: `With the earlier periods' fees, taken a year (× ${t.periodsInYear} ÷ ${t.periods}: the credits are monthly amounts) inside the tax for the year below.`, source: sourceFor(SOURCES.additionalMedical, taxYear),
    }, [
      { key: 'paye.medicalFees.employee', label: 'Deducted from the employee (4005)', amount: input.medicalFees.employee },
      ...(input.medicalFees.employer !== 0 ? [{
        key: 'paye.medicalFees.employer', label: 'Paid by the employer (3810), deemed paid by the employee', amount: input.medicalFees.employer,
        source: sourceFor(SOURCES.employerMedical, taxYear),
      }] : []),
    ]));
  }
  if (t.annualDeduction > 0 || t.contributionsToDate > 0) steps.push(retirementStep(input));
  if (t.offPeriodicTaxed !== t.offPeriodic) {
    steps.push({
      key: 'paye.retirement.toDate', label: 'The deduction off periodic pay to date, bounded by the cap to date', amount: t.deductionOffPeriodicToDate,
      formula: `the lesser of ${r(t.offPeriodic)} × ${t.periods} ÷ (${annualisationFactorWords(t.factor)}) and the cap to date ${r(t.capToDate)}`,
      children: [{ key: 'paye.retirement.taxed', label: 'So the deduction off the annual equivalent', amount: t.offPeriodicTaxed, formula: `${r(t.deductionOffPeriodicToDate)} × (${annualisationFactorWords(t.factor)}) ÷ ${t.periods}` }],
    });
  }
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
    formula: `${liabilityAE(t)}${t.annualAll > 0 ? ` + (${r(t.atAll.annualTax)} − ${r(t.atAE.annualTax)})` : ''}`,
    ...(creditsUsed(t.atAE) > 0 ? { note: `The medical credits are monthly amounts (s6A): the tax for the year before them comes off × periods ÷ the factor, and the ${r(creditsUsed(t.atAE))} of credits it used × ${Math.min(t.periods, t.periodsInYear)} ÷ ${t.periodsInYear} (${r(t.creditsOnAEToDate)}), never more than that tax${t.periods > t.periodsInYear ? ' (a year\'s worth at most)' : ''}.` } : {}),
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
