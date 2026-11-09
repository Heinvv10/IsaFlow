/**
 * An independent contractor on the e@syFile certificate (TS-b; PAYE-GEN-01-G21 (2027) Rev 1 p. 26): the income "reflects
 * under code 3616", never 3601 (the employee's gross salary), and tax deducted from it is PAYE as for anyone.
 * IsaFlow takes no PAYE from a contractor (taxStatusTreatment), so a contractor with none withheld and no directive has
 * nothing a certificate can carry: an IT3(a) needs a 4150 reason, and the reasons the BRS lists (02-10: below the threshold,
 * labour broker, ...) do not include a contractor's. Writing one under 3601 would put an above-threshold contractor through
 * nilTaxReason, which refuses the WHOLE file. So such a contractor is left off with a warning that names them (LOW
 * confidence: no SARS source fetched says no certificate is due; check the position before filing).
 * A contractor with PAYE withheld (a directive, or tax taken before the status was set) gets an IRP5 with the income under 3616.
 */
import { formatMoney } from '@/lib/money/formatMoney';

export interface ContractorFilingInput {
  taxStatus: string;
  who: string;
  /** The certificate's salary income as the run lines give it (what would be 3601). */
  salaryIncome: number;
  /** PAYE withheld over the year, cents, directive and stand-alone PAYE included. */
  paye: number;
  hasLumpSums: boolean;
}

export type ContractorFiling =
  | { kind: 'employee' }
  | { kind: 'skip'; warning: string }
  | { kind: 'certificate'; income3616: number };

export function contractorFiling(i: ContractorFilingInput): ContractorFiling {
  if (i.taxStatus !== 'independent_contractor') return { kind: 'employee' };
  if (i.paye === 0 && !i.hasLumpSums) {
    return {
      kind: 'skip',
      warning: `${i.who}: independent contractor with no PAYE withheld (${formatMoney(i.salaryIncome)} paid): no certificate is written. `
        + 'Their income would be code 3616 (PAYE-GEN-01-G21 p. 26), and a certificate with no tax needs a 4150 reason that does not exist for a contractor. '
        + 'If the SARS independent-contractor tests make this person an employee, change the tax status and recalculate.',
    };
  }
  return { kind: 'certificate', income3616: i.salaryIncome };
}
