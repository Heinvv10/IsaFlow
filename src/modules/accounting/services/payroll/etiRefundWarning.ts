/**
 * Review round 2 L3 (wave 5 ET; Hein ruling R-C): the period's unused ETI is the refund claimable on the EMP501 at
 * the end of August or February (ETI Act s10(1)), and the August/February payroll journals book it. When no journal of
 * that month has booked it (no run journal and no directive in the month), the EMP201 says so by name; the integrity
 * check paye_payable_differs_from_emp201 reports the same month.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { bookedByEtiJournals, bookedByRunJournal } from './etiBooking';
import { index, type EtiCarryMonth, type YearMonth } from './etiCarry';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** One warning per August/February of `from`.. with a refund claimable that the ledger has not booked in full. */
export async function unbookedRefundWarnings(companyId: string, ledger: EtiCarryMonth[], from: YearMonth): Promise<string[]> {
  const warnings: string[] = [];
  for (const m of ledger) {
    if (index(m) < index(from) || (m.month !== 2 && m.month !== 8) || m.refundClaimable < 0.005) continue;
    const booked = (await bookedByRunJournal(companyId, m)).refund + (await bookedByEtiJournals(companyId, m)).refund;
    if (booked >= m.refundClaimable - 0.005) continue;
    const period = m.month === 8 ? `March–August ${m.year}` : `September ${m.year - 1}–February ${m.year}`;
    warnings.push(`ETI refund ${formatMoney(m.refundClaimable)} claimable for ${period} is not booked`
      + (booked > 0 ? ` in full (${formatMoney(booked)} booked)` : '')
      + `: no ${MONTHS[m.month - 1]} ${m.year} payroll journal has booked it (ETI Act s10(1)). Post the ${MONTHS[m.month - 1]} pay run to book it.`);
  }
  return warnings;
}
