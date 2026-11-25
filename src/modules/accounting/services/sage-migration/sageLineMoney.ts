/**
 * What a PO line and header are BOOKED at must be Sage's own figures, or the PO is refused (round-13 breaker B13-1). PURE. The PO tool books
 * a line at its `line_total` (Sage Exclusive) with the tax the tool computes at the line's rate when no `tax_amount` is sent, and at
 * quantity x price when no line total is sent; so a figure Sage gives that the tool would not book is checked here:
 *   - a line Tax or Total with no Exclusive is refused: it would be dropped, the line booked at quantity x price;
 *   - Exclusive + Tax + Total: Total is their sum; Exclusive + Total, no Tax: Total is Exclusive + the tax the tool computes (lineCents);
 *   - fields that can be checked are read, and pass when they agree: a line's UnitPriceInclusive (UnitPriceExclusive at the line rate),
 *     the header's SubTotal (= Exclusive) and AmountDue (= Total; a PO with payments or credits against it is not imported).
 */
import { cents, lineCents } from '@/modules/accounting/services/ap/purchaseOrderImportAmounts';
import { MONEY_FIELD_MARK } from './sageMoneyFields';
import { readNumber, type Raw } from './sageValues';

type Figure = number | null | undefined;
const num = (v: Figure): v is number => typeof v === 'number';

export interface LineFigures { quantity: Figure; unit: Figure; exclusive: Figure; tax: Figure; total: Figure; rate: Figure }

/** The reasons a line's money is not what the tool would book (pushed into `why`, unprefixed). Reads UnitPriceInclusive. */
export function lineMoneyReasons(raw: Raw, f: LineFigures, why: string[]): void {
  if (f.exclusive === null) {
    for (const [key, v] of [['Tax', f.tax], ['Total', f.total]] as const) {
      if (num(v)) why.push(`${key} is given without Exclusive: the line's own net figure is needed to check it (it is refused, not booked at quantity x price)`);
    }
  }
  if (num(f.exclusive) && num(f.total)) {
    if (num(f.tax)) {
      if (cents(f.exclusive) + cents(f.tax) !== cents(f.total)) why.push(`Total ${f.total} is not Exclusive ${f.exclusive} + Tax ${f.tax}`);
    } else if (num(f.rate) && num(f.quantity) && num(f.unit)) {
      const m = lineCents({ quantity: f.quantity, unitPrice: f.unit, taxRate: f.rate, lineTotal: f.exclusive }, false);
      if (typeof m !== 'string' && m.net + m.tax !== cents(f.total)) why.push(`Total ${f.total} is not Exclusive ${f.exclusive} + its tax at ${f.rate}% (${(m.net + m.tax) / 100})`);
    }
  }
  const inclusive = readNumber(raw, 'UnitPriceInclusive', why, { cents: 'any' });
  if (num(inclusive) && num(f.unit) && num(f.rate)) {
    const expected = cents(f.unit * (1 + f.rate / 100));
    if (cents(inclusive) !== expected) why.push(`UnitPriceInclusive ${inclusive} is not UnitPriceExclusive ${f.unit} at ${f.rate}% (${expected / 100})`);
  }
}

/** The header's SubTotal and AmountDue, read and checked against Exclusive and Total. */
export function headerMoneyReasons(o: Raw, exclusive: Figure, total: Figure, why: string[]): void {
  const subTotal = readNumber(o, 'SubTotal', why, { cents: 'whole' });
  if (num(subTotal) && num(exclusive) && cents(subTotal) !== cents(exclusive)) why.push(`SubTotal ${subTotal} is not Exclusive ${exclusive}`);
  const due = readNumber(o, 'AmountDue', why, { cents: 'whole' });
  if (num(due) && num(total) && cents(due) !== cents(total)) {
    why.push(`AmountDue ${due} is not Total ${total}: a PO with payments or credits against it is not imported ${MONEY_FIELD_MARK}`);
  }
}
