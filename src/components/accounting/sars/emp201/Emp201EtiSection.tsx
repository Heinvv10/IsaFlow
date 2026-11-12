/**
 * EMP201 field section: ETI and the PAYE payable after it (wave 5 ET). The period's ETI, what was brought forward and
 * used, what carries on, the refund claimable at the end of August or February (ETI Act s9(1), s10), any ETI the ledger
 * has not booked, and, for a one-month EMP201, "Book ETI for this month". PAYE less "ETI used" is PAYE payable.
 */
import { fmt, type DrillOpener, type EMP201Data } from './emp201Types';
import { SummaryRow } from './Emp201SummaryRow';
import { Emp201BookEtiButton } from './Emp201BookEtiButton';

interface Props { data: EMP201Data; month?: string | null; onBooked?: () => void; onDrill?: DrillOpener }

export function Emp201EtiSection({ data, month = null, onBooked, onDrill }: Props) {
  const carry = data.etiCarry;
  return (
    <>
      <SummaryRow label="ETI for the period" value={fmt(data.totalETI)} onDrill={onDrill?.('eti', data.totalETI)} />
      {carry.broughtForward > 0 && <SummaryRow label="ETI brought forward from earlier months" value={fmt(carry.broughtForward)} />}
      <SummaryRow label="Less: ETI used (Employment Tax Incentive)" value={fmt(-carry.used)} />
      {carry.carriedForward > 0 && <SummaryRow label="ETI carried forward to next month" value={fmt(carry.carriedForward)} />}
      {carry.refundClaimable > 0 && <SummaryRow label="ETI refund claimable on the EMP501 (s10)" value={fmt(carry.refundClaimable)} />}
      {(data.etiWarnings ?? []).map((w) => (
        <p key={w} role="note" className="px-4 py-2 text-xs text-amber-700 dark:text-amber-400">{w}</p>
      ))}
      {month && <Emp201BookEtiButton month={month} onBooked={onBooked} />}
      <SummaryRow label="PAYE payable" value={fmt(data.payePayable)} bold />
    </>
  );
}
