/**
 * The PAYE explanation steps of a line taxed by an IRP3(b) fixed-percentage or IRP3(c) fixed-amount directive (wave 5 DR,
 * after EX-core): the directive's own arithmetic as directiveRegularPay applied it. Pure; it arranges the engine's figures
 * and computes none. payeExplain uses these steps in place of the tables / flat-rate steps (one assembler line).
 * Step keys are read by tests/unit/services/payroll/payrollExplainRecompute.helpers.ts.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { pct, sourceFor, type ExplainSource, type ExplainStep } from './payrollExplainTypes';
import type { RegularPayDirective } from './directiveRegularPay';

const G21 = 'https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G21-Guide-for-Employers-iro-Employees-Tax-for-2027-External-Guide.pdf';
const SOURCE: ExplainSource = {
  label: 'SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 15-17, tax directives (IRP3(b) fixed percentage, IRP3(c) fixed amount)', href: G21,
};

/** What the line's directive PAYE was made of (directiveRegularPay / capDirectivePaye). */
export interface DirectiveExplainInput {
  directive: RegularPayDirective;
  /** Periodic remuneration before deductions, a clawback netted in; and positive annual payments (3605). */
  base: number;
  annualBase: number;
  /** The directive's PAYE before the cap, regular and annual. */
  regular: number;
  annual: number;
  /** The cash the line could withhold from, when the directed PAYE was capped to it; else null. */
  capRoom: number | null;
}

export function directivePayeSteps(input: DirectiveExplainInput, taxYear: number): ExplainStep[] {
  const { directive: d } = input;
  const name = d.number?.trim() ? `SARS directive ${d.number.trim()}` : 'The SARS directive';
  const steps: ExplainStep[] = [{
    key: 'paye.treatment', label: `${name}: ${d.type === 'fixed_percentage' ? 'a fixed percentage (IRP3(b))' : 'a fixed amount (IRP3(c))'}, not the tables`,
    amount: null, source: sourceFor(SOURCE, taxYear),
  }];
  if (d.type === 'fixed_percentage') {
    steps.push(
      { key: 'paye.regularDirective.base', label: 'Remuneration before deductions (retirement fund and donations not taken off)', amount: input.base },
      { key: 'paye.regularDirective.annualBase', label: 'Annual payments (3605) this period', amount: input.annualBase },
      { key: 'paye.regularDirective.rate', label: 'Directed rate', amount: d.rate, unit: 'percent' },
      { key: 'paye.regularDirective.regular', label: 'PAYE on regular pay', amount: input.regular, formula: `${pct(d.rate)} × ${formatMoney(input.base)}, rounded to the cent` },
      { key: 'paye.regularDirective.annual', label: 'PAYE on the annual payments', amount: input.annual, formula: `${pct(d.rate)} × ${formatMoney(input.annualBase)}, rounded to the cent` },
    );
  } else {
    steps.push(
      { key: 'paye.regularDirective.base', label: 'Regular remuneration this period', amount: input.base },
      { key: 'paye.regularDirective.fixed', label: 'Directed PAYE a period', amount: d.fixedAmount, note: 'Read as per monthly period: the SARS guide does not say (UNVERIFIED).', status: 'unverified' },
      { key: 'paye.regularDirective.regular', label: 'PAYE on regular pay', amount: input.regular, formula: 'The directed amount when regular pay was paid, else nil' },
      { key: 'paye.regularDirective.annual', label: 'PAYE on annual payments, from the tables', amount: input.annual, status: 'unverified' },
    );
  }
  if (input.capRoom != null) {
    steps.push({
      key: 'paye.regularDirective.cap', label: 'Cash the line pays after UIF: PAYE withheld up to it', amount: input.capRoom,
      note: 'Tax is deducted from the remuneration (G21 p. 17): the rest of the directed PAYE was not withheld.',
    });
  }
  return steps;
}
