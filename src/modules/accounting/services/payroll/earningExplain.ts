/**
 * One earning as an explanation step (EX-core), shared by PAYE, UIF and SDL: what the totals took of it. A travel
 * allowance (3701) or company vehicle (3802) counts at its PAYE share, 80% or 20% (FB, fringeBenefits.ts, G21 p. 5);
 * its step shows the amount and the share as parts of the formula. Pure; the figures are the accumulator's.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import type { EarningPart } from './payrollLineAccumulate';
import { pct, type ExplainSource, type ExplainStep } from './payrollExplainTypes';

const G21 = 'https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G21-Guide-for-Employers-iro-Employees-Tax-for-2027-External-Guide.pdf';
const FRINGE_SOURCE: ExplainSource = { label: 'SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 5, travel allowance and company vehicle: 80%, or 20% with at least 80% business use', href: G21 };

export function earningStep(key: string, p: EarningPart): ExplainStep {
  const label = `${p.name} (${p.code})${p.isNonCash ? ', a non-cash benefit' : ''}`;
  if (p.rate === undefined) return { key, label, amount: p.included };
  return {
    key, label, amount: p.included, formula: `${pct(p.rate)} of ${formatMoney(p.amount)}, to the cent`, source: FRINGE_SOURCE,
    children: [
      { key: `${key}.amount`, label: 'The full amount', amount: p.amount },
      { key: `${key}.share`, label: 'The share that is remuneration', amount: p.rate, unit: 'percent' },
    ],
  };
}
