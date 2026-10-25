/**
 * The VAT201 as the SARS form lays it out (FV V2016): fields 1, 1A, 2, 2A, 3,
 * 4, 4A, 5-13 for output tax and 14-20 for input tax, numbered and worded as on
 * the form (docs/sars/2026-07-VAT201-isv-dossier.md s2a). One surface renders
 * this and nothing else numbers the return.
 *
 * EVERY VALUE COMES FROM THE SERVICES, never from the page:
 *   - tax fields (4, 4A, 12, 14-18) and the totals (13, 19, 20) from the
 *     `getVat201Report` boxes and totals — the journal-derived ledger basis;
 *   - supply values 1 and 1A from the box bases PLUS their tax: the form's values
 *     are VAT-inclusive (field 4 = field 1 x r/(100+r)), unlike the ledger's
 *     VAT-exclusive base; 2, 2A and 3 carry no VAT and come from
 *     `getNilRatedSupplies`, because a zero-rated or exempt supply posts no VAT
 *     control leg and the box basis never sees it (see that file).
 *
 * DOMESTIC REVERSE CHARGE. DRC input tax is an ordinary claim, so the report
 * numbers it 15 and it is in field 15; DRC output tax stays in field 12. UNVERIFIED: SARS DRC guide not on file, so the
 * field notes say so whenever DRC tax is present.
 *
 * TWO RESIDUALS keep the form's own arithmetic true. Field 12 ("other and
 * imported services") is all output tax NOT on fields 4/4A, and field 18
 * ("other") is all input tax not on 14-17, so an unmapped VAT type (box
 * `unclassified`) still lands on the form instead of making 13 or 19 disagree
 * with the lines above them. When a residual holds more than the box it is
 * named for, the field's note says so.
 *
 * WHAT IS NOT FILLED. Accommodation (5-9) and change in use / second-hand goods
 * (10-11) have no ledger source, and the ledger cannot tell imported capital
 * goods (14A) from other imports (15A) — its one imported box is `14A/15A`,
 * reported here as 15A. Those fields carry `amount: null` and a note instead of
 * a zero, because "R0.00" on a statutory form is a claim.
 *
 * Field 1 gives back the nil-rated share of a mixed journal
 * (`NilRatedSupplies.onTaxedJournals`), which `deriveVatBoxes` apportioned into
 * the taxed base (a nil-rated line has no VAT, so the share comes off as is). The share is taken from field 1 even where the journal's taxed
 * type was capital goods — a mixed capital/nil journal is the one case where
 * field 1A is overstated by it.
 */
import type { NilRatedSupplies } from './vat201NilRatedSupplies';
import type { Vat201Report } from './vat201ReportService';

export type Vat201SarsGroup =
  | 'output-supplies' | 'output-accommodation' | 'output-adjustments' | 'output-total'
  | 'input-supplies' | 'input-adjustments' | 'input-total' | 'result';

export interface Vat201SarsLayoutField {
  field: string;
  label: string;
  /** `value`: rand value of supplies. `tax`: a VAT amount. */
  kind: 'value' | 'tax';
  group: Vat201SarsGroup;
}

export interface Vat201SarsField extends Vat201SarsLayoutField {
  /** Null when IsaFlow has no source for the field — see the file header. */
  amount: number | null;
  note?: string;
}

export const VAT201_SARS_LAYOUT: readonly Vat201SarsLayoutField[] = [
  { field: '1', label: 'Standard rate (excluding capital goods and/or services and accommodation)', kind: 'value', group: 'output-supplies' },
  { field: '4', label: 'Output tax on field 1', kind: 'tax', group: 'output-supplies' },
  { field: '1A', label: 'Standard rate (only capital goods and/or services)', kind: 'value', group: 'output-supplies' },
  { field: '4A', label: 'Output tax on field 1A', kind: 'tax', group: 'output-supplies' },
  { field: '2', label: 'Zero rate (excluding goods exported)', kind: 'value', group: 'output-supplies' },
  { field: '2A', label: 'Zero rate (only exported goods)', kind: 'value', group: 'output-supplies' },
  { field: '3', label: 'Exempt and non-supplies', kind: 'value', group: 'output-supplies' },
  { field: '5', label: 'Accommodation exceeding 28 days', kind: 'value', group: 'output-accommodation' },
  { field: '6', label: 'Accommodation exceeding 28 days, taken into account (field 5 x percentage)', kind: 'value', group: 'output-accommodation' },
  { field: '7', label: 'Accommodation not exceeding 28 days', kind: 'value', group: 'output-accommodation' },
  { field: '8', label: 'Total accommodation (6 + 7)', kind: 'value', group: 'output-accommodation' },
  { field: '9', label: 'Output tax on accommodation (field 8)', kind: 'tax', group: 'output-accommodation' },
  { field: '10', label: 'Change in use and export of second-hand goods', kind: 'value', group: 'output-adjustments' },
  { field: '11', label: 'Output tax on change in use and export of second-hand goods (field 10)', kind: 'tax', group: 'output-adjustments' },
  { field: '12', label: 'Other and imported services', kind: 'tax', group: 'output-adjustments' },
  { field: '13', label: 'Total output tax (4 + 4A + 9 + 11 + 12)', kind: 'tax', group: 'output-total' },
  { field: '14', label: 'Capital goods and/or services supplied to you', kind: 'tax', group: 'input-supplies' },
  { field: '14A', label: 'Capital goods imported by you', kind: 'tax', group: 'input-supplies' },
  { field: '15', label: 'Other goods and/or services supplied to you (not capital goods)', kind: 'tax', group: 'input-supplies' },
  { field: '15A', label: 'Other goods imported by you (not capital goods)', kind: 'tax', group: 'input-supplies' },
  { field: '16', label: 'Change in use', kind: 'tax', group: 'input-adjustments' },
  { field: '17', label: 'Bad debts', kind: 'tax', group: 'input-adjustments' },
  { field: '18', label: 'Other', kind: 'tax', group: 'input-adjustments' },
  { field: '19', label: 'Total input tax (14 + 14A + 15 + 15A + 16 + 17 + 18)', kind: 'tax', group: 'input-total' },
  { field: '20', label: 'VAT payable / refundable (Total A - Total B)', kind: 'tax', group: 'result' },
];

const INCLUDES_VAT = 'Value including VAT: the form takes the tax in the next field as this value x r/(100+r).';
const EXPORT_CAUTION = 'May include exported services, which belong in field 2: the ledger cannot tell exported goods from exported services.';
const NOT_TRACKED = 'IsaFlow does not compute this field. Complete it on eFiling if it applies to this period.';
const IMPORTED_CAPITAL = 'IsaFlow books imported goods in one box and cannot separate capital goods; that tax is included in field 15A.';

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

type ReportBoxes = Pick<Vat201Report, 'boxes' | 'totals'>;

function boxOf(report: ReportBoxes, boxNo: string): { base: number; tax: number } {
  const matching = report.boxes.filter((b) => b.box === boxNo);
  return {
    base: r2(matching.reduce((s, b) => s + b.base, 0)),
    tax: r2(matching.reduce((s, b) => s + b.tax, 0)),
  };
}

function unmappedNote(residual: number, named: number, what: string): string | undefined {
  const extra = r2(residual - named);
  if (Math.abs(extra) < 0.005) return undefined;
  return `Includes ${extra.toFixed(2)} of ${what} with no field of its own.`;
}

/**
 * Fill the SARS form for a period from the report and the nil-rated supplies.
 * Pure: the same inputs give the same form, and every field of the layout is
 * present in layout order whatever the period holds.
 */
export function buildVat201SarsFields(report: ReportBoxes, nilRated: NilRatedSupplies): Vat201SarsField[] {
  const standard = boxOf(report, '1');
  const capital = boxOf(report, '1A');
  const field12 = r2(report.totals.outputTax - standard.tax - capital.tax);

  // Domestic reverse charge INPUT tax is an ordinary input claim: field 15 with
  // the other goods and services, never 16 (change in use). The report numbers
  // it 15 itself (vat201ReportService BOX_NUMBERS); the VAT type is read here
  // only to say so in the note. No ledger type says "capital", so DRC never
  // reaches field 14. UNVERIFIED: SARS DRC guide not on file; the repo's own
  // audit (docs/audits/2026-10-18/vat-fx-rounding.md V12) puts it in box 15.
  const drcInput = r2(report.boxes
    .filter((b) => b.direction === 'input' && b.vatType === 'reverse_charge')
    .reduce((s, b) => s + b.tax, 0));
  const drcOutput = r2(report.boxes
    .filter((b) => b.direction === 'output' && b.vatType === 'reverse_charge')
    .reduce((s, b) => s + b.tax, 0));
  const inputCapital = boxOf(report, '14').tax;
  const inputOther = boxOf(report, '15').tax; // includes `input:reverse_charge`, which the report numbers 15
  const inputImported = boxOf(report, '14A/15A').tax;
  const inputBad = boxOf(report, '17').tax;
  const field18 = r2(report.totals.inputTax - inputCapital - inputOther - inputImported - inputBad);

  const values: Record<string, { amount: number | null; note?: string }> = {
    '1': {
      amount: r2(standard.base + standard.tax - (nilRated.onTaxedJournals - nilRated.onTaxedCapital)),
      note: INCLUDES_VAT,
    },
    '4': { amount: standard.tax },
    '1A': { amount: r2(capital.base + capital.tax - nilRated.onTaxedCapital), note: INCLUDES_VAT },
    '4A': { amount: capital.tax },
    '2': { amount: r2(nilRated.zeroRated - nilRated.exported) },
    '2A': { amount: nilRated.exported, note: EXPORT_CAUTION },
    '3': { amount: nilRated.exempt },
    '12': {
      amount: field12,
      note: [
        drcOutput !== 0
          ? `Includes ${drcOutput.toFixed(2)} of domestic reverse charge output tax. UNVERIFIED: SARS DRC guide not on file.`
          : undefined,
        unmappedNote(field12, boxOf(report, '12').tax, 'output tax'),
      ].filter(Boolean).join(' ') || undefined,
    },
    '13': { amount: r2(report.totals.outputTax) },
    '14': { amount: inputCapital },
    '14A': { amount: null, note: IMPORTED_CAPITAL },
    '15': {
      amount: inputOther,
      note: drcInput !== 0
        ? `Includes ${drcInput.toFixed(2)} of domestic reverse charge input tax. UNVERIFIED: SARS DRC guide not on file.`
        : undefined,
    },
    '15A': { amount: inputImported },
    '16': { amount: null, note: NOT_TRACKED },
    '17': { amount: inputBad },
    '18': {
      amount: field18,
      note: unmappedNote(field18, boxOf(report, '18').tax, 'input tax'),
    },
    '19': { amount: r2(report.totals.inputTax) },
    '20': { amount: r2(report.totals.netVat) },
  };

  return VAT201_SARS_LAYOUT.map((layout) => {
    const filled = values[layout.field] ?? { amount: null, note: NOT_TRACKED };
    return { ...layout, amount: filled.amount, ...(filled.note ? { note: filled.note } : {}) };
  });
}

export interface Vat201FormWarning {
  code: 'negative-supply-value' | 'mixed-capital-and-nil-rated' | 'uncoded-revenue-assumed-zero-rated';
  message: string;
  amount: number;
}

const SUPPLY_VALUE_FIELDS = ['1', '1A', '2', '2A', '3'];

/**
 * What the reviewer should look at before filing, and that the form alone does
 * not say. Not part of the pre-filing exceptions count: those feed the eFiling
 * and mark-submitted gates, and these are judgement calls about classification
 * that the user confirms, not figures that are wrong against the books.
 */
export function buildVat201Warnings(fields: readonly Vat201SarsField[], nilRated: NilRatedSupplies): Vat201FormWarning[] {
  const warnings: Vat201FormWarning[] = [];
  for (const f of fields) {
    if (SUPPLY_VALUE_FIELDS.includes(f.field) && f.amount !== null && f.amount < 0) {
      warnings.push({
        code: 'negative-supply-value', amount: f.amount,
        message: `Field ${f.field} is negative (${f.amount.toFixed(2)}). A VAT201 cannot declare a negative supply value; check the credit notes in this period.`,
      });
    }
  }
  if (nilRated.onTaxedAmbiguous !== 0) {
    warnings.push({
      code: 'mixed-capital-and-nil-rated', amount: nilRated.onTaxedAmbiguous,
      message: `${nilRated.onTaxedAmbiguous.toFixed(2)} of zero-rated or exempt supplies sit on journals that also carry capital-goods and other taxed output. The ledger cannot say whether it comes off field 1 or 1A (it was taken from field 1). Check both.`,
    });
  }
  if (nilRated.uncodedAssumedZeroRated !== 0) {
    warnings.push({
      code: 'uncoded-revenue-assumed-zero-rated', amount: nilRated.uncodedAssumedZeroRated,
      message: `${nilRated.uncodedAssumedZeroRated.toFixed(2)} of revenue with no VAT code, on documents that raised no VAT, is reported as zero-rated (field 2). Confirm it is not exempt or exported.`,
    });
  }
  return warnings;
}
