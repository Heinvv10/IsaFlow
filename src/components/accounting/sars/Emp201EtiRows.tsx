/**
 * The EMP201's ETI lines (wave 5 ET): the period's ETI, what was brought forward and used, what carries on, the
 * refund claimable at the end of August or February (ETI Act s9(1), s10), and any ETI the ledger has not booked.
 * PAYE less "ETI used" is PAYE payable. Kept out of pages/accounting/sars/emp201.tsx (review L6).
 */
import { formatMoney } from '@/lib/money/formatMoney';

export interface Emp201EtiCarry { broughtForward: number; used: number; carriedForward: number; refundClaimable: number }

/** The EMP201 response's ETI fields (ETI Act s9(1), s10): payable = PAYE - etiCarry.used. */
export interface Emp201EtiFields { etiCarry: Emp201EtiCarry; etiWarnings?: string[] }

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-3 flex items-center justify-between">
      <span className="text-sm text-[var(--ff-text-secondary)]">{label}</span>
      <span className="text-sm font-medium text-[var(--ff-text-secondary)]">{value}</span>
    </div>
  );
}

export function Emp201EtiRows({ totalETI, etiCarry, warnings }: { totalETI: number; etiCarry: Emp201EtiCarry; warnings: string[] }) {
  return (
    <>
      <Row label="ETI for the period" value={formatMoney(totalETI)} />
      {etiCarry.broughtForward > 0 && <Row label="ETI brought forward from earlier months" value={formatMoney(etiCarry.broughtForward)} />}
      <Row label="Less: ETI used (Employment Tax Incentive)" value={formatMoney(-etiCarry.used)} />
      {etiCarry.carriedForward > 0 && <Row label="ETI carried forward to next month" value={formatMoney(etiCarry.carriedForward)} />}
      {etiCarry.refundClaimable > 0 && <Row label="ETI refund claimable on the EMP501 (s10)" value={formatMoney(etiCarry.refundClaimable)} />}
      {warnings.map((w) => (
        <p key={w} role="note" className="px-4 py-2 text-xs text-amber-700 dark:text-amber-400">{w}</p>
      ))}
    </>
  );
}

/** The ETI lines of the EMP201 CSV export, in the page's order. */
/** The CSV's ETI rows and the PAYE payable row (PAYE net of the ETI used). */
export function emp201EtiCsvRows(totalETI: number, etiCarry: Emp201EtiCarry, payePayable: number): string[][] {
  return [
    ['ETI', 'Employment Tax Incentive for the period', totalETI.toFixed(2)],
    ['ETI brought forward', 'Unused ETI from earlier months (ETI Act s9(1))', etiCarry.broughtForward.toFixed(2)],
    ['ETI used', 'ETI set off against PAYE', etiCarry.used.toFixed(2)],
    ['ETI carried forward', 'Unused ETI for the next month', etiCarry.carriedForward.toFixed(2)],
    ['ETI refund claimable', 'Unused ETI at the end of August or February, claimed on the EMP501 (s10)', etiCarry.refundClaimable.toFixed(2)],
    ['PAYE Payable', 'PAYE net of ETI used', payePayable.toFixed(2)],
  ];
}
