/** The cells that show one document (number, date, total, open amount) in a pairing table. */
import { formatCurrency, formatDate } from '@/utils/formatters';
import type { PairingDoc } from '@/modules/accounting/services/intercompany/pairingTypes';

export const TH = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-muted';
export const TD = 'px-3 py-2 text-sm text-[var(--ff-text-primary)]';
export const NUM = 'text-right tabular-nums';

/** Rand through the shared formatter; any other currency as its code and the plain figure (the pairing never converts). */
const money = (doc: PairingDoc, amount: number): string => (doc.currency === 'ZAR' ? formatCurrency(amount) : `${doc.currency} ${amount.toFixed(2)}`);

export function DocCells({ doc }: { doc: PairingDoc | null }) {
  if (!doc) {
    return <td colSpan={4} className={`${TD} text-ink-muted italic`}>Not open any more, or not offered by the partner</td>;
  }
  return (
    <>
      <td className={`${TD} font-medium whitespace-nowrap`}>{doc.number}</td>
      <td className={`${TD} whitespace-nowrap`}>{formatDate(doc.date)}</td>
      <td className={`${TD} ${NUM}`}>{money(doc, doc.total)}</td>
      <td className={`${TD} ${NUM}`}>{money(doc, doc.open)}</td>
    </>
  );
}

export function DocHeads({ side }: { side: string }) {
  return (
    <>
      <th scope="col" className={TH}>{side} no.</th>
      <th scope="col" className={TH}>Date</th>
      <th scope="col" className={`${TH} text-right`}>Total</th>
      <th scope="col" className={`${TH} text-right`}>Open</th>
    </>
  );
}
