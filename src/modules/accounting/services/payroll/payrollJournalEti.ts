/**
 * What the payroll journal plan says about ETI (wave 5 ET): the brought-forward amount it books and the ETI it leaves
 * for later months. The amounts are the ETI ledger's month line (etiCarry), the EMP201's own figures.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import { bookedByEtiJournals } from './etiBooking';
import { etiMonthForRun } from './etiCarryRead';
import type { EtiCarryMonth, YearMonth } from './etiCarry';

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

/** The ETI a run's journal books (ETI used, and the August/February refund), net of what the month's ETI journals booked. */
export interface RunEti {
  month: EtiCarryMonth;
  etiUsed: number;
  refund: number;
  /** The ETI refund receivable (migration 974): null when the role has no account (a blocker if a refund is due). */
  refundAccount: { id: string; accountCode: string; accountName: string } | null;
}

/** The ETI refund receivable (system role, migration 974), or null when no account holds it. */
export async function refundReceivable(companyId: string): Promise<{ id: string; accountCode: string; accountName: string } | null> {
  try {
    return await getSystemAccount('eti_refund_receivable', companyId);
  } catch (err) {
    if (err instanceof MissingSystemAccountError) return null;
    throw err;
  }
}

export async function etiForRun(companyId: string, ym: YearMonth, run: { paye: number; eti: number }): Promise<RunEti> {
  const month = await etiMonthForRun(companyId, ym, run);
  const booked = await bookedByEtiJournals(companyId, ym);
  const refund = Math.round((month.refundClaimable - booked.refund) * 100) / 100;
  return {
    month, refund,
    etiUsed: Math.round((month.used - booked.used) * 100) / 100,
    // Resolved only when there is a refund to book: no read of the role otherwise.
    refundAccount: Math.abs(refund) < 0.005 ? null : await refundReceivable(companyId),
  };
}

/**
 * The refund lines (Hein ruling R-C; ETI Act s10(1)): DR ETI refund receivable / CR the ETI offset on labour, for the
 * ETI the period leaves unused at the end of August or February. A blocker when a refund is due and no account holds
 * the role.
 */
export function etiRefundLines(
  r: RunEti, labour: { id: string | null; name: string; inactive: boolean },
): { lines: Array<{ glAccountId: string | null; accountCode: string; accountName: string; debit: number; credit: number; description: string; inactiveAccount: boolean; cc1Id: null }>; blocker: EtiJournalNote | null } {
  if (Math.abs(r.refund) < 0.005) return { lines: [], blocker: null };
  if (!r.refundAccount) {
    return { lines: [], blocker: { code: 'missing_eti_refund_account', detail: `${formatMoney(r.refund)} of ETI is due back from SARS at the end of the ETI period (ETI Act s10(1)), but no account holds the ETI refund receivable role. Add it (migration 974 seeds 1150), then post.` } };
  }
  const debit = r.refund > 0;
  const amount = Math.abs(r.refund);
  return {
    blocker: null,
    lines: [
      { glAccountId: r.refundAccount.id, accountCode: r.refundAccount.accountCode, accountName: r.refundAccount.accountName,
        debit: debit ? amount : 0, credit: debit ? 0 : amount, description: 'ETI refund claimable on the EMP501 (ETI Act s10(1))', inactiveAccount: false, cc1Id: null },
      { glAccountId: labour.id, accountCode: '5200', accountName: labour.name,
        debit: debit ? 0 : amount, credit: debit ? amount : 0, description: 'ETI refund: the unused ETI of the period', inactiveAccount: labour.inactive, cc1Id: null },
    ],
  };
}
