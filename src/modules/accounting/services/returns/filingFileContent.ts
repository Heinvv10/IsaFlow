/**
 * The filing file of a finalised return version (wave 6 EFa, ruling 15): built from the VERSION ROW alone (its stored
 * figures, period and number), never from the live ledger or payroll, so the same version always gives the same bytes.
 *
 * SARS publishes no upload format for the VAT201 or EMP201 on eFiling: both are web forms (the VAT201 wire format is the
 * ISV channel's, provisional and dark). So the file is a CAPTURE SHEET: the form's values in eFiling's order, as CSV.
 * Its sha256 is what migration 999v stamps on the version. The VAT201 JSON is the same values for a machine to read
 * and carries that sha256, so both name the one stamped sheet.
 *
 * Nothing here sends anything anywhere (F23: tests/unit/services/returns/filingFileBoundary.test.ts).
 */
import { createHash } from 'crypto';
import { csvCell } from '@/lib/csv';
import type { ReturnVersion } from './returnVersionTypes';

export type FilingFileKind = 'vat201_capture_csv' | 'emp201_capture_csv';

export interface CaptureSheet {
  kind: FilingFileKind;
  /** Header row, then rows: text cells are quoted, amounts are plain two-decimal numbers. */
  csv: string;
  sha256: string;
  /** e.g. VAT201_202603_v1 (no extension). */
  baseName: string;
  /** The rows as read on the PDF: [section, label, amount]. */
  rows: Array<[string, string, string]>;
}

const cents = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null);
const money = (c: number | null): string => (c === null ? '' : (c / 100).toFixed(2));
const amount = (v: unknown): string => money(cents(v));
const sum = (...vs: unknown[]): string => {
  const cs = vs.map(cents);
  return cs.some((c) => c === null) ? '' : money(cs.reduce<number>((s, c) => s + (c as number), 0));
};
/** SARS's tax period: the period end as YYYYMM. */
const taxPeriod = (v: ReturnVersion): string => v.periodEnd.slice(0, 7).replace('-', '');
/** Amounts (and an empty, unrecorded one) bare; every other cell quoted and formula-neutralised. */
const line = (cells: string[]): string => cells.map((c) => (/^-?\d+\.\d{2}$/.test(c) || c === '' ? c : csvCell(c))).join(',');
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function header(v: ReturnVersion): Array<[string, string, string]> {
  return [
    ['Return', 'Form', v.formType], ['Return', 'Tax period', taxPeriod(v)],
    ['Return', 'Period', `${v.periodStart} to ${v.periodEnd}`], ['Return', 'Version', `${v.versionNo} (${v.id})`],
  ];
}

interface StoredBox { box?: unknown; label?: unknown; direction?: unknown; base?: unknown; tax?: unknown }

/**
 * The stored report boxes (numbered as the SARS fields, vat201ReportService BOX_NUMBERS), each with its value excluding
 * VAT (the journal base, as stored), its VAT, and the two added: the form asks for consideration INCLUDING VAT on the
 * supply fields (1, 1A, 2, 2A, 3), so the capturer reads that column there.
 */
type VatRow = [string, string, string, string, string];

function vatRows(v: ReturnVersion): VatRow[] {
  const f = v.figures;
  const boxes = (Array.isArray(f.sarsFields) ? f.sarsFields : []) as StoredBox[];
  return [
    ...header(v).map(([s, l, x]): VatRow => [s, l, x, '', '']),
    ...boxes.map((b): VatRow => [
      b.direction === 'input' ? 'Input tax' : 'Output tax', `Field ${String(b.box ?? '')}: ${String(b.label ?? '')}`,
      amount(b.base), amount(b.tax), sum(b.base, b.tax)]),
    ['Totals', 'Field 4: Total output tax', '', amount(f.outputTax), ''] as VatRow,
    ['Totals', 'Field 19: Total input tax', '', amount(f.inputTax), ''] as VatRow,
    ['Totals', 'Field 20: Net VAT payable (negative: refundable)', '', amount(f.netVat), ''] as VatRow,
  ];
}

interface StoredCarry { broughtForward?: unknown; used?: unknown; carriedForward?: unknown }

function empRows(v: ReturnVersion): Array<[string, string, string]> {
  const f = v.figures;
  const carry = (f.etiCarry ?? {}) as StoredCarry;
  return [
    ...header(v),
    ['Payroll tax calculations', 'PAYE', amount(f.totalPAYE)],
    ['Payroll tax calculations', 'SDL', amount(f.totalSDL)],
    ['Payroll tax calculations', 'UIF', amount(f.totalUIF)],
    ['Payroll tax calculations', 'Payroll tax liability', sum(f.totalPAYE, f.totalSDL, f.totalUIF)],
    ['Employment Tax Incentive', 'ETI brought forward', amount(carry.broughtForward)],
    ['Employment Tax Incentive', 'ETI calculated', amount(f.totalETI)],
    ['Employment Tax Incentive', 'ETI utilised', amount(carry.used)],
    ['Employment Tax Incentive', 'ETI carried forward', amount(carry.carriedForward)],
    ['Payment details', 'PAYE (after ETI utilised)', amount(f.payePayable)],
    ['Payment details', 'SDL', amount(f.totalSDL)],
    ['Payment details', 'UIF', amount(f.totalUIF)],
    ['Payment details', 'Tax payable', sum(f.payePayable, f.totalSDL, f.totalUIF)],
    ['Payment details', 'Payment reference number', 'Shown by eFiling on this EMP201: type it back to mark the return filed'],
  ];
}

/** The capture sheet of a VAT201 or EMP201 version. Its CSV ends with a newline; an empty amount was not recorded. */
export function buildCaptureSheet(v: ReturnVersion): CaptureSheet {
  const baseName = `${v.formType}_${taxPeriod(v)}_v${v.versionNo}`;
  if (v.formType === 'VAT201') {
    const rows = vatRows(v);
    const csv = `${[line(['section', 'field', 'value_excl_vat', 'vat', 'value_incl_vat']), ...rows.map(line)].join('\r\n')}\r\n`;
    return { kind: 'vat201_capture_csv', csv, sha256: sha256(csv), baseName,
      rows: rows.map(([s, l, base, vat, incl]): [string, string, string] => [s, base ? `${l} (incl. VAT ${incl})` : l, vat]) };
  }
  const rows = empRows(v);
  const csv = `${[line(['section', 'field', 'amount']), ...rows.map(line)].join('\r\n')}\r\n`;
  return { kind: 'emp201_capture_csv', csv, sha256: sha256(csv), baseName, rows };
}

/** The VAT201 values as JSON, naming the stamped capture sheet by its sha256. */
export function buildVat201Json(v: ReturnVersion, sheet: CaptureSheet): string {
  const f = v.figures;
  const boxes = (Array.isArray(f.sarsFields) ? f.sarsFields : []) as StoredBox[];
  return `${JSON.stringify({
    form: 'VAT201', taxPeriod: taxPeriod(v), periodStart: v.periodStart, periodEnd: v.periodEnd,
    versionNo: v.versionNo, versionId: v.id,
    fields: boxes.map((b) => ({ field: String(b.box ?? ''), label: String(b.label ?? ''), direction: String(b.direction ?? ''),
      valueExclVat: amount(b.base), vat: amount(b.tax), valueInclVat: sum(b.base, b.tax) })),
    outputTax: amount(f.outputTax), inputTax: amount(f.inputTax), netVat: amount(f.netVat),
    captureSheetSha256: sheet.sha256,
  }, null, 2)}\n`;
}
