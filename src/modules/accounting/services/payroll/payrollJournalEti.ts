/**
 * What the payroll journal plan says about ETI (wave 5 ET): the brought-forward amount it books and the ETI it leaves
 * for later months. The amounts are the ETI ledger's month line (etiCarry), the EMP201's own figures.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import type { EtiCarryMonth } from './etiCarry';

export interface EtiJournalNote { code: string; detail: string }

export function etiAdvisories(month: EtiCarryMonth, etiUsed: number): EtiJournalNote[] {
  const notes: EtiJournalNote[] = [];
  if (month.broughtForward > 0.005) {
    notes.push({
      code: 'eti_brought_forward',
      detail: `${formatMoney(month.broughtForward)} of ETI is brought forward from earlier months of the reconciliation period (ETI Act s9(1)); `
        + `${formatMoney(etiUsed)} of ETI is booked against this month's PAYE, as the EMP201 uses it.`,
    });
  }
  if (month.carriedForward > 0.005) {
    notes.push({
      code: 'eti_beyond_paye',
      detail: `The month has ${formatMoney(month.available)} of ETI available but its PAYE is ${formatMoney(month.paye)}, so only ${formatMoney(etiUsed)} is booked. `
        + `The remaining ${formatMoney(month.carriedForward)} is not booked: the EMP201 carries it into the next month, or claims it as a refund at the end of August or February (ETI Act s9(1), s10).`,
    });
  }
  return notes;
}
