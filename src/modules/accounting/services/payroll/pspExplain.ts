/**
 * The PAYE explanation of a personal service provider's line (wave 6 PSP; one line in payrollExplain). Pure: it arranges
 * the engine's figures (taxStatusTreatment's flat_psp) and computes none. A directive's own steps win, as in the engine.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { explainPaye, type PayeExplainInput } from './payeExplain';
import type { PspFacts } from './taxStatusTreatment';
import { SOURCES, pct, sourceFor, type ExplainStep, type FigureExplanation } from './payrollExplainTypes';

const A06 = {
  label: 'SARS PAYE-GEN-01-G01-A06 row 6, personal service providers: 27% for a company or close corporation, 45% for a trust',
  href: 'https://www.sars.gov.za/wp-content/uploads/Docs/PAYE/Tables/2024/PAYE-GEN-01-G01-A06-2025-Other-Employment-Tax-Deduction-Tables-External-Annexure.pdf',
};

export function explainPspPaye(input: PayeExplainInput, psp: PspFacts & { base: number }): FigureExplanation {
  if (input.directiveSteps || input.treatment !== 'flat_psp') return explainPaye(input);
  const { base } = psp;
  const steps: ExplainStep[] = [
    {
      key: 'paye.treatment', label: `Personal service provider (a ${psp.entity}): the ${psp.entity}'s income tax rate, not the tables`,
      amount: null, source: sourceFor(A06, input.taxYear),
    },
    {
      key: 'paye.balance', label: 'The payment before any deduction, less non-cash items (no s11F, s18A or fringe benefit applies to a company or trust)',
      amount: base,
    },
    { key: 'paye.flatRate', label: `Flat rate for a ${psp.entity}`, amount: psp.rate, unit: 'percent' },
    {
      key: 'paye.flat', label: 'PAYE at the flat rate', amount: input.split.regular,
      formula: `${pct(psp.rate)} × ${formatMoney(base)}, rounded half-up to the cent, never below nil`,
    },
  ];
  if (input.split.directive !== 0) {
    steps.push({ key: 'paye.directive', label: 'Plus PAYE on a lump sum as SARS directed', amount: input.split.directive, source: sourceFor(SOURCES.directive, input.taxYear) });
  }
  return { figure: 'paye', title: 'How PAYE was calculated', steps, result: input.paye, resultLabel: 'PAYE this period' };
}
