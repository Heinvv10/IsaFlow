/**
 * Late input-VAT claims in the VAT201 box arithmetic.
 *
 * A late claim (VAT Act s16(3), gl/vatLateClaimSplit.ts) is a companion journal
 * DR VAT Input / CR "Input VAT - late claims", dated in the first open VAT
 * period after the locked one its bill was dated in. Its tax belongs in this
 * period's input boxes. Its BASE does not exist here — the supply was recorded
 * on the original, in the locked period — and the clearing leg is not a
 * supply: fed to `deriveVatBoxes` it reads as a negative base and fails the 15%
 * check, and a journal with no base is listed in `entriesWithoutBase`.
 *
 * So a journal with a leg on the clearing account plays the `late_claim` role:
 * its tax legs are added to their boxes as `lateClaimTax` — counted in `tax`
 * and in the totals, but left out of the base check, whose variance is
 * `(tax − lateClaimTax) − base × 15%` — and it is never an entry without base.
 * Its reversal (the same legs, swapped) nets it out the same way.
 *
 * A separate file so vatBoxBasis.ts does not grow; every other journal goes
 * through `deriveVatBoxes` unchanged.
 */
import {
  classifyVatJournalLine,
  deriveVatBoxes,
  type VatBasisResult,
  type VatBoxRow,
  type VatLineInput,
} from './vatBoxBasis';

/** The clearing account's subtype (migration 701). */
export const VAT_LATE_CLAIM_SUBTYPE = 'vat_input_late_claim';

export interface LateClaimBoxRow extends VatBoxRow {
  /** Tax in this box claimed late: in `tax`, out of the base check. */
  lateClaimTax: number;
}

export interface VatBasisWithLateClaims extends VatBasisResult {
  boxes: LateClaimBoxRow[];
  /** Input tax claimed late in this period, across every box. */
  lateClaimInputTax: number;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function deriveVatBoxesWithLateClaims(lines: readonly VatLineInput[]): VatBasisWithLateClaims {
  const lateEntries = new Set(
    lines.filter((l) => l.accountSubtype === VAT_LATE_CLAIM_SUBTYPE).map((l) => l.journalEntryId),
  );
  const basis = deriveVatBoxes(lines.filter((l) => !lateEntries.has(l.journalEntryId)));
  const rows = new Map<string, LateClaimBoxRow>(
    basis.boxes.map((b) => [`${b.direction}:${b.vatType}`, { ...b, lateClaimTax: 0 }]),
  );

  let taxLegCount = basis.taxLegCount;
  for (const line of lines) {
    if (!lateEntries.has(line.journalEntryId)) continue;
    const c = classifyVatJournalLine(line);
    if (c.role !== 'tax' || !c.direction) continue;
    taxLegCount++;
    const vatType = c.vatType ?? 'standard';
    const key = `${c.direction}:${vatType}`;
    const row = rows.get(key)
      ?? { direction: c.direction, vatType, base: 0, tax: 0, impliedTax: 0, variance: 0, lateClaimTax: 0 };
    row.tax = r2(row.tax + c.amount);
    row.lateClaimTax = r2(row.lateClaimTax + c.amount);
    row.variance = r2(row.tax - row.lateClaimTax - row.impliedTax);
    rows.set(key, row);
  }

  const boxes = [...rows.values()].sort((a, b) =>
    (a.direction === b.direction ? a.vatType.localeCompare(b.vatType) : a.direction < b.direction ? -1 : 1));
  const late = (d: 'input' | 'output') =>
    r2(boxes.filter((b) => b.direction === d).reduce((s, b) => s + b.lateClaimTax, 0));
  const lateInput = late('input');
  const lateOutput = late('output');

  return {
    ...basis,
    boxes,
    outputTax: r2(basis.outputTax + lateOutput),
    inputTax: r2(basis.inputTax + lateInput),
    taxLegCount,
    lateClaimInputTax: lateInput,
  };
}
