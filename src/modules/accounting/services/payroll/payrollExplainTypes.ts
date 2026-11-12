/**
 * "How was this calculated?" for a payroll line's statutory figures (wave 5 EX-core): the stored shape.
 *
 * An explanation is built from the intermediate values the engines expose (payeCumulative's trace, the UIF leviable
 * amount, sdlLeviableTrace, the ETI result) and never recomputes one. Each step's `amount` is the engine's own figure,
 * unrounded where the engine did not round it, so the steps recompute the line's result to the cent
 * (tests/unit/services/payroll/payrollExplainRecompute.test.ts). `key` is a stable id for that test and for later
 * engine PRs; `label` is what a person reads. Stored as JSON in payroll_run_lines.explanation (migration 973).
 */

export type ExplainedFigure = 'paye' | 'uif' | 'sdl' | 'eti';

export type ExplainUnit = 'rand' | 'percent' | 'count';

export interface ExplainSource {
  label: string;
  /** https only (the drawer links it through safeHref). */
  href?: string;
  /** The SARS tax year the rule or table belongs to, e.g. "2026/27". */
  taxYear?: string;
}

export interface ExplainStep {
  key: string;
  label: string;
  /** The engine's figure; null for a step that is words only (a reason, a treatment). */
  amount: number | null;
  /** How the amount reads: rand (money), percent (0.18 = 18%), count (periods, months). Default rand. */
  unit?: ExplainUnit;
  formula?: string;
  /** Words shown with the step (a reason, an assumption). */
  note?: string;
  source?: ExplainSource;
  /** 'unverified': the rule has no SARS source confirmed; the figure carries a caution. */
  status?: 'verified' | 'unverified';
  /** The amount is the sum of the children's (deductions are negative); a "Not below nil" child shows a floor. */
  total?: true;
  children?: ExplainStep[];
}

/**
 * A step that is the sum of its parts. Where the engine floored that sum at nil, the parts add to less than the amount
 * and a "Not below nil" part says by how much, so every total foots on screen (payrollExplainFooting.test.ts).
 */
export function footed(step: Omit<ExplainStep, 'children' | 'total'>, parts: ExplainStep[]): ExplainStep {
  const sum = parts.reduce((s, c) => s + (c.amount ?? 0), 0);
  const floor = (step.amount ?? 0) - sum;
  // Half a cent and less is the engine rounding a total to the cent (stated in the step's formula), not a floor.
  const children = Math.abs(floor) > 0.005 + 1e-9 ? [...parts, { key: `${step.key}.floor`, label: 'Not below nil', amount: floor }] : parts;
  return { ...step, total: true, children };
}

/** A rate as people read it: 0.275 → "27.5%". */
export const pct = (share: number): string => `${Math.round(share * 100_000) / 1000}%`;

export interface FigureExplanation {
  figure: ExplainedFigure;
  title: string;
  steps: ExplainStep[];
  /** The figure stored on the line (for UIF, the employee's contribution; the employer's is equal). */
  result: number;
  resultLabel: string;
  caution?: string;
}

export interface LineExplanations {
  /** Bumped when the shape changes, so a reader can tell an old record. */
  schema: 1;
  taxYear: number;
  /** PAYROLL_CALCULATION_VERSION the line was costed under. */
  calculationVersion: number;
  paye: FigureExplanation;
  uif: FigureExplanation;
  sdl: FigureExplanation;
  eti: FigureExplanation;
}

/** "2026/27" for tax year 2027 (1 March 2026 to 28 February 2027). */
export const taxYearLabel = (taxYear: number): string => `${taxYear - 1}/${String(taxYear).slice(-2)}`;

const G21 = 'https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G21-Guide-for-Employers-iro-Employees-Tax-for-2027-External-Guide.pdf';

/** The SARS sources the explanations cite. Pages are those the engine files cite beside each rule. */
export const SOURCES = {
  rates: { label: 'SARS rates of tax for individuals', href: 'https://www.sars.gov.za/tax-rates/income-tax/rates-of-tax-for-individuals/' },
  medicalCredits: { label: 'SARS medical tax credit rates', href: 'https://www.sars.gov.za/tax-rates/medical-tax-credit-rates/' },
  additionalMedical: { label: 'SARS Guide on the Determination of Medical Tax Credits, Issue 18, p. 21 and 31-32 (s6B(3)(a)(i))' },
  annualEquivalent: { label: 'SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 8, annual equivalent (Fourth Schedule para 9)', href: G21 },
  retirement: { label: 'SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 10-11, retirement fund contributions (s11F)', href: G21 },
  donations: { label: 'SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 10, s18A donations', href: G21 },
  annualPayment: { label: 'SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 32-33, annual payments', href: G21 },
  employerMedical: { label: 'SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 12, employer medical contributions (Seventh Schedule para 12A)', href: G21 },
  nonStandard: { label: 'SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 28, non-standard employment', href: G21 },
  contractor: { label: 'SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 26, independent contractors', href: G21 },
  directive: { label: 'SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 26, tax directives', href: G21 },
  uif: { label: 'SARS Unemployment Insurance Fund (contribution rate and monthly ceiling)', href: 'https://www.sars.gov.za/types-of-tax/unemployment-insurance-fund/' },
  sdl: { label: 'SDL Act s3(3); SARS SDL-GEN-01-G01 Rev 5 s6, leviable amount after para 2(4) deductions' },
  sdlThreshold: { label: 'SDL Act s4(b): an employer at or under the annual threshold is exempt', href: 'https://www.sars.gov.za/types-of-tax/skills-development-levy/' },
  eti: {
    label: 'SARS Guide to the Employment Tax Incentive, Issue 5, §2.4; SARS ETI "How much is the incentive"',
    href: 'https://www.sars.gov.za/wp-content/uploads/Ops/Guides/LAPD-ETI-G01-Guide-to-the-Employment-Tax-Incentive.pdf',
  },
} as const satisfies Record<string, ExplainSource>;

/** A source with the tax year it applies to. */
export const sourceFor = (source: ExplainSource, taxYear: number): ExplainSource => ({ ...source, taxYear: taxYearLabel(taxYear) });
