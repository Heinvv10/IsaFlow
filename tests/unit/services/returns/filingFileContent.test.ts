/**
 * Byte fixtures for the filing files (wave 6 EFa): the VAT201 and EMP201 capture CSVs (the stored, stamped files), the
 * VAT201 JSON and the EMP201 PDF, each from a seeded version. The CSV fixtures were read line by line against the seed:
 * the VAT201 is IsaFlow's SARS form (vat201SarsFields) field for field, the EMP201 its totals in cents, text quoted.
 *
 * emp201-capture.pdf.sha256 pins the PDF's bytes: a jspdf or jspdf-autotable bump changes them, so regenerate the
 * fixture with that bump (the stored CSV, and so every stamp, is unaffected: the PDF is read from it).
 */
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCaptureSheet, buildVat201Json, parseCaptureCsv,
} from '@/modules/accounting/services/returns/filingFileContent';
import { buildCaptureSheetPdf, pdfDateUtc } from '@/modules/accounting/services/returns/filingFilePdf';
import { ReturnRefusal, type ReturnVersion } from '@/modules/accounting/services/returns/returnVersionTypes';
import { EMP_VERSION, VAT_FORM, VAT_VERSION } from './filingFileSeed';

const fixture = (name: string): string => readFileSync(path.join(__dirname, '../../../fixtures/efiling', name), 'utf8');
const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const rowsOf = (v: ReturnVersion): string[][] => parseCaptureCsv(buildCaptureSheet(v).csv);
const field = (rows: string[][], n: string): string[][] => rows.filter((r) => r[0] !== 'Return' && r[1] === n);
const TZ = process.env.TZ;
afterEach(() => { process.env.TZ = TZ; });

describe('filing file content', () => {
  it('VAT201 capture CSV matches its byte fixture, and the stamp is its sha256', () => {
    const sheet = buildCaptureSheet(VAT_VERSION);
    expect(sheet.csv).toBe(fixture('vat201-capture.csv'));
    expect(sheet.sha256).toBe(sha(sheet.csv));
    expect(sheet.kind).toBe('vat201_capture_csv@1');
  });

  it('EMP201 capture CSV matches its byte fixture: liability = PAYE + SDL + UIF, payable = PAYE after ETI + SDL + UIF', () => {
    const sheet = buildCaptureSheet(EMP_VERSION);
    expect(sheet.csv).toBe(fixture('emp201-capture.csv'));
    expect(sheet.csv).toContain('"Payroll tax liability",45105.90');
    expect(sheet.csv).toContain('"Tax payable",43105.90');
    expect(sheet.kind).toBe('emp201_capture_csv@1');
  });

  it('VAT201 JSON, read from the stored CSV, matches its byte fixture and names the CSV by its sha256', () => {
    const sheet = buildCaptureSheet(VAT_VERSION);
    const json = buildVat201Json(sheet.csv, sheet.sha256);
    expect(json).toBe(fixture('vat201-capture.json'));
    expect(JSON.parse(json).captureSheetSha256).toBe(sheet.sha256);
  });

  it('a figure the version did not record is left empty, never 0.00; a refund keeps its sign', () => {
    const older = { ...EMP_VERSION, figures: { ...EMP_VERSION.figures, etiCarry: undefined } };
    expect(buildCaptureSheet(older).csv).toContain('"Employment Tax Incentive","ETI brought forward",\r\n');
    const form = VAT_FORM.map((f) => (f.field === '20' ? { ...f, amount: -1234.5 } : f));
    const refund = { ...VAT_VERSION, figures: { ...VAT_VERSION.figures, sarsForm: form } };
    expect(field(rowsOf(refund), '20')[0]![3]).toBe('-1234.50');
    expect(field(rowsOf(VAT_VERSION), '16')[0]![3]).toBe(''); // IsaFlow does not compute field 16: empty, not 0.00
  });

  it('the file is the version row\'s: the same version gives the same bytes, a different figure a different stamp', () => {
    expect(buildCaptureSheet(EMP_VERSION).sha256).toBe(buildCaptureSheet({ ...EMP_VERSION }).sha256);
    const moved = { ...EMP_VERSION, figures: { ...EMP_VERSION.figures, totalSDL: 2100.11 } };
    expect(buildCaptureSheet(moved).sha256).not.toBe(buildCaptureSheet(EMP_VERSION).sha256);
  });

  it('the EMP201 PDF, read from the stored CSV, is the same bytes in any TZ (creation date in UTC)', async () => {
    const sheet = buildCaptureSheet(EMP_VERSION);
    expect(pdfDateUtc('2026-04-03T09:15:00.000Z')).toBe("D:20260403091500+00'00'");
    process.env.TZ = 'Africa/Johannesburg';
    const local = await buildCaptureSheetPdf(sheet.csv, sheet.sha256, 'EMP201', EMP_VERSION.finalisedAt);
    process.env.TZ = 'UTC';
    const utc = await buildCaptureSheetPdf(sheet.csv, sheet.sha256, 'EMP201', EMP_VERSION.finalisedAt);
    expect(local.subarray(0, 5).toString()).toBe('%PDF-');
    expect(local.toString('latin1')).toContain("/CreationDate (D:20260403091500+00'00')");
    expect(sha(local)).toBe(sha(utc));
    expect(sha(local)).toBe(fixture('emp201-capture.pdf.sha256').trim());
  });
});

describe('A. the VAT201 sheet is IsaFlow\'s SARS form (vat201SarsFields), field for field', () => {
  const rows = rowsOf(VAT_VERSION);
  const amount = (n: string): string => field(rows, n)[0]![3]!;

  it('A1: every field of the form, once each, in the form\'s order; no report box label such as 14A/15A', () => {
    expect(rows.filter((r) => r[0] !== 'Return').slice(1).map((r) => r[1])).toEqual(VAT_FORM.map((f) => f.field));
    expect(rows.some((r) => r.join(' ').includes('14A/15A'))).toBe(false);
    expect(field(rows, '13')[0]![2]).toMatch(/^Total output tax/);
    expect(field(rows, '4')[0]![2]).toBe('Output tax on field 1');
  });

  it('A2: shared box numbers are summed as the form sums them (15 = ordinary + DRC input); 12 holds the rest of output tax', () => {
    expect(amount('15')).toBe('4950.50');
    expect(field(rows, '15')[0]![4]).toMatch(/domestic reverse charge/);
    expect(amount('12')).toBe('1500.00');
    expect(amount('13')).toBe('18000.00');
    expect(amount('19')).toBe('8550.50');
    expect(amount('20')).toBe('9449.50');
  });

  it('A3: the supply fields: 1 includes VAT less the nil-rated share of taxed journals; 2, 2A and 3 from the nil-rated supplies', () => {
    expect(amount('1')).toBe('112500.00'); // 100000 + 15000 - 2500
    expect(amount('1A')).toBe('11500.00');
    expect(amount('2')).toBe('37999.75'); // 50000 - 12000.25 exported
    expect(amount('2A')).toBe('12000.25');
    expect(amount('3')).toBe('8000.00');
  });

  it('a version finalised before the form was recorded has no sheet: 409 FILING_FILE_NO_FORM_LAYOUT, nothing invented', () => {
    const { sarsForm: _f, ...older } = VAT_VERSION.figures;
    for (const figures of [older, { ...older, sarsForm: VAT_FORM.slice(1) }, { ...older, sarsForm: [...VAT_FORM].reverse() }]) {
      let thrown: unknown;
      try { buildCaptureSheet({ ...VAT_VERSION, figures }); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(ReturnRefusal);
      expect(thrown).toMatchObject({ status: 409, refusalCode: 'FILING_FILE_NO_FORM_LAYOUT' });
    }
  });
});

describe('B. the EMP201 ETI section foots in a reconciliation-period end month (August)', () => {
  it('brought forward + calculated - utilised = carried forward + refund claimable, and the refund is on the sheet', () => {
    const v: ReturnVersion = { ...EMP_VERSION, periodStart: '2026-08-01', periodEnd: '2026-08-31',
      figures: { ...EMP_VERSION.figures, totalPAYE: 1000, totalETI: 1200, payePayable: 0,
        etiCarry: { broughtForward: 300, used: 1000, carriedForward: 0, refundClaimable: 500 } } };
    const rows = rowsOf(v);
    const get = (l: string): number => Number(rows.find((r) => r[1] === l)?.[2]);
    expect(get('ETI refund claimable (EMP501)')).toBe(500);
    expect(get('ETI brought forward') + get('ETI calculated') - get('ETI utilised'))
      .toBe(get('ETI carried forward') + get('ETI refund claimable (EMP501)'));
  });
});

describe('parseCaptureCsv', () => {
  it('reads back quoted cells with commas, doubled quotes and empty amounts', () => {
    expect(parseCaptureCsv('"a, b","say ""hi""",,1.00\r\n"x",\r\n')).toEqual([['a, b', 'say "hi"', '', '1.00'], ['x', '']]);
  });
});
