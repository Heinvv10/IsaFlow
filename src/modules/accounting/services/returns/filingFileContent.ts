/**
 * The filing file of a finalised return version (wave 6 EFa, ruling 15): built from the VERSION ROW alone (its stored
 * figures, period and number), never from the live ledger or payroll.
 *
 * SARS publishes no upload format for the VAT201 or EMP201 on eFiling: both are web forms (the VAT201 wire format is the
 * ISV channel's, provisional and dark). So the file is a CAPTURE SHEET: the form's values in eFiling's order, as CSV.
 * The first download stores the CSV on the version with its sha256 (migration 999v); every later download serves the
 * STORED CSV, and the VAT201 JSON and the EMP201 PDF are read from it (parseCaptureCsv), so a change to this generator
 * never changes, or strands, a stamped file. The kind carries the generator's version (`@1`): bump it with any change to
 * what the CSV says.
 *
 * VAT201: the form as IsaFlow lays it out (vat201SarsFields, fields 1 to 20) with the amounts recorded at finalise
 * (figures.sarsForm). A version finalised before the form was recorded has no sheet (409): its fields are never
 * re-derived or invented.
 *
 * Nothing here sends anything anywhere (F23: tests/unit/services/returns/filingFileBoundary.test.ts).
 */
import { createHash } from 'crypto';
import { csvCell } from '@/lib/csv';
import { VAT201_SARS_LAYOUT, type Vat201SarsGroup } from '@/modules/accounting/services/reports/vat201SarsFields';
import { ReturnRefusal, type ReturnForm, type ReturnVersion } from './returnVersionTypes';

/** `<file>@<generator version>`, as 999v's CHECK pairs it with the form. */
export const FILING_FILE_KIND = { VAT201: 'vat201_capture_csv@1', EMP201: 'emp201_capture_csv@1' } as const satisfies Record<ReturnForm, string>;
export type FilingFileKind = (typeof FILING_FILE_KIND)[ReturnForm];

export interface CaptureSheet {
  kind: FilingFileKind;
  /** Header row, then rows: text cells are quoted, amounts are plain two-decimal numbers. */
  csv: string;
  sha256: string;
}

const cents = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null);
const money = (c: number | null): string => (c === null ? '' : (c / 100).toFixed(2));
const amount = (v: unknown): string => money(cents(v));
const sum = (...vs: unknown[]): string => {
  const cs = vs.map(cents);
  return cs.some((c) => c === null) ? '' : money(cs.reduce<number>((s, c) => s + (c as number), 0));
};
/** SARS's tax period: the period end as YYYYMM. */
const taxPeriod = (v: Pick<ReturnVersion, 'periodEnd'>): string => v.periodEnd.slice(0, 7).replace('-', '');
/** Amounts (and an empty, unrecorded one) bare; every other cell quoted and formula-neutralised. */
const line = (cells: string[]): string => cells.map((c) => (/^-?\d+\.\d{2}$/.test(c) || c === '' ? c : csvCell(c))).join(',');
export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const toCsv = (head: string[], rows: string[][]): string => `${[line(head), ...rows.map(line)].join('\r\n')}\r\n`;

/** The download's file name (no extension), e.g. VAT201_202603_v1. */
export const filingFileBaseName = (v: Pick<ReturnVersion, 'formType' | 'periodEnd' | 'versionNo'>): string =>
  `${v.formType}_${taxPeriod(v)}_v${v.versionNo}`;

function header(v: ReturnVersion): Array<[string, string]> {
  return [['Form', v.formType], ['Tax period', taxPeriod(v)], ['Period', `${v.periodStart} to ${v.periodEnd}`],
    ['Version', `${v.versionNo} (${v.id})`]];
}

const SECTION: Record<Vat201SarsGroup, string> = {
  'output-supplies': 'Output tax: supplies', 'output-accommodation': 'Output tax: accommodation',
  'output-adjustments': 'Output tax: adjustments', 'output-total': 'Total A',
  'input-supplies': 'Input tax: supplies', 'input-adjustments': 'Input tax: adjustments', 'input-total': 'Total B',
  result: 'Result',
};

interface StoredField { field: string; label: string; amount: number | null; note?: string }

/** The SARS form recorded at finalise, field for field in the layout's order, or null when it was not recorded. */
function storedForm(v: ReturnVersion): StoredField[] | null {
  const f = v.figures.sarsForm;
  if (!Array.isArray(f) || f.length !== VAT201_SARS_LAYOUT.length) return null;
  const ok = f.every((x: unknown, i) => {
    const r = x as Record<string, unknown>;
    return r !== null && typeof r === 'object' && r.field === VAT201_SARS_LAYOUT[i]!.field && typeof r.label === 'string'
      && (r.amount === null || cents(r.amount) !== null) && (r.note === undefined || typeof r.note === 'string');
  });
  return ok ? (f as StoredField[]) : null;
}

function vatCsv(v: ReturnVersion): string {
  const form = storedForm(v);
  if (!form) {
    throw new ReturnRefusal(409, `Version ${v.versionNo} was finalised before IsaFlow recorded the SARS form with it, so it `
      + 'has no filing file: its fields are never re-derived. Amend it and finalise again to get one.', 'FILING_FILE_NO_FORM_LAYOUT');
  }
  return toCsv(['section', 'field', 'label', 'value', 'note'], [
    ...header(v).map(([l, x]) => ['Return', '', l, x, '']),
    ...form.map((f, i) => [SECTION[VAT201_SARS_LAYOUT[i]!.group], f.field, f.label, amount(f.amount), f.note ?? '']),
  ]);
}

interface StoredCarry { broughtForward?: unknown; used?: unknown; carriedForward?: unknown; refundClaimable?: unknown }

function empCsv(v: ReturnVersion): string {
  const f = v.figures;
  const carry = (f.etiCarry ?? {}) as StoredCarry;
  return toCsv(['section', 'field', 'amount'], [
    ...header(v).map(([l, x]) => ['Return', l, x]),
    ['Payroll tax calculations', 'PAYE', amount(f.totalPAYE)],
    ['Payroll tax calculations', 'SDL', amount(f.totalSDL)],
    ['Payroll tax calculations', 'UIF', amount(f.totalUIF)],
    ['Payroll tax calculations', 'Payroll tax liability', sum(f.totalPAYE, f.totalSDL, f.totalUIF)],
    ['Employment Tax Incentive', 'ETI brought forward', amount(carry.broughtForward)],
    ['Employment Tax Incentive', 'ETI calculated', amount(f.totalETI)],
    ['Employment Tax Incentive', 'ETI utilised', amount(carry.used)],
    ['Employment Tax Incentive', 'ETI carried forward', amount(carry.carriedForward)],
    // August and February close an ETI reconciliation period: what is not carried forward is claimed on the EMP501.
    ['Employment Tax Incentive', 'ETI refund claimable (EMP501)', amount(carry.refundClaimable)],
    ['Payment details', 'PAYE (after ETI utilised)', amount(f.payePayable)],
    ['Payment details', 'SDL', amount(f.totalSDL)],
    ['Payment details', 'UIF', amount(f.totalUIF)],
    ['Payment details', 'Tax payable', sum(f.payePayable, f.totalSDL, f.totalUIF)],
    ['Payment details', 'Payment reference number', 'Shown by eFiling on this EMP201: type it back to mark the return filed'],
  ]);
}

/** The capture sheet of a VAT201 or EMP201 version. Its CSV ends with a newline; an empty amount was not recorded. */
export function buildCaptureSheet(v: ReturnVersion): CaptureSheet {
  const csv = v.formType === 'VAT201' ? vatCsv(v) : empCsv(v);
  return { kind: FILING_FILE_KIND[v.formType], csv, sha256: sha256Hex(csv) };
}

/** The rows of a capture CSV (header first), as written: quoted cells unquoted, `""` read as `"`. */
export function parseCaptureCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i]!;
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && csv[i + 1] === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; i += 1;
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** The VAT201 values as JSON, read from the STORED capture CSV and naming it by its sha256. */
export function buildVat201Json(csv: string, captureSheetSha256: string): string {
  const [, ...rows] = parseCaptureCsv(csv);
  const ret = Object.fromEntries(rows.filter((r) => r[0] === 'Return').map((r) => [r[2], r[3]]));
  return `${JSON.stringify({
    form: ret.Form, taxPeriod: ret['Tax period'], period: ret.Period, version: ret.Version,
    fields: rows.filter((r) => r[0] !== 'Return').map(([section, field, label, value, note]) => ({
      section, field, label, value: value === '' ? null : value, ...(note ? { note } : {}),
    })),
    captureSheetSha256,
  }, null, 2)}\n`;
}
