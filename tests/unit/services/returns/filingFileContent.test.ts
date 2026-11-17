/**
 * Byte fixtures for the filing files (wave 6 EFa): the VAT201 and EMP201 capture CSVs (the stamped files), the VAT201
 * JSON and the EMP201 PDF, each from a seeded version. The CSV fixtures were read line by line against the seed: field
 * order, the cents arithmetic of the totals and the incl.-VAT column, quoting of text, and a negative net.
 */
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildCaptureSheet, buildVat201Json } from '@/modules/accounting/services/returns/filingFileContent';
import { buildCaptureSheetPdf } from '@/modules/accounting/services/returns/filingFilePdf';
import { EMP_VERSION, VAT_VERSION } from './filingFileSeed';

const fixture = (name: string): string => readFileSync(path.join(__dirname, '../../../fixtures/efiling', name), 'utf8');
const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

describe('filing file content', () => {
  it('VAT201 capture CSV matches its byte fixture, and the stamp is its sha256', () => {
    const sheet = buildCaptureSheet(VAT_VERSION);
    expect(sheet.csv).toBe(fixture('vat201-capture.csv'));
    expect(sheet.sha256).toBe(sha(sheet.csv));
    expect(sheet.kind).toBe('vat201_capture_csv');
    expect(sheet.baseName).toBe('VAT201_202603_v2');
  });

  it('EMP201 capture CSV matches its byte fixture: liability = PAYE + SDL + UIF, payable = PAYE after ETI + SDL + UIF', () => {
    const sheet = buildCaptureSheet(EMP_VERSION);
    expect(sheet.csv).toBe(fixture('emp201-capture.csv'));
    expect(sheet.csv).toContain('"Payroll tax liability",45105.90');
    expect(sheet.csv).toContain('"Tax payable",43105.90');
    expect(sheet.kind).toBe('emp201_capture_csv');
  });

  it('VAT201 JSON matches its byte fixture and names the capture sheet by its sha256', () => {
    const sheet = buildCaptureSheet(VAT_VERSION);
    const json = buildVat201Json(VAT_VERSION, sheet);
    expect(json).toBe(fixture('vat201-capture.json'));
    expect(JSON.parse(json).captureSheetSha256).toBe(sheet.sha256);
  });

  it('a figure the version did not record is left empty, never 0.00; a refund keeps its sign', () => {
    const older = { ...EMP_VERSION, figures: { ...EMP_VERSION.figures, etiCarry: undefined } };
    const csv = buildCaptureSheet(older).csv;
    expect(csv).toContain('"Employment Tax Incentive","ETI brought forward",\r\n');
    const refund = { ...VAT_VERSION, figures: { ...VAT_VERSION.figures, netVat: -1234.5 } };
    expect(buildCaptureSheet(refund).csv).toContain('(negative: refundable)",,-1234.50,\r\n');
  });

  it('the file is the version row\'s: the same version gives the same bytes, a different figure a different stamp', async () => {
    expect(buildCaptureSheet(EMP_VERSION).sha256).toBe(buildCaptureSheet({ ...EMP_VERSION }).sha256);
    const moved = { ...EMP_VERSION, figures: { ...EMP_VERSION.figures, totalSDL: 2100.11 } };
    expect(buildCaptureSheet(moved).sha256).not.toBe(buildCaptureSheet(EMP_VERSION).sha256);
    const sheet = buildCaptureSheet(EMP_VERSION);
    const pdf1 = await buildCaptureSheetPdf(sheet, 'EMP201', EMP_VERSION.finalisedAt);
    const pdf2 = await buildCaptureSheetPdf(sheet, 'EMP201', EMP_VERSION.finalisedAt);
    expect(pdf1.subarray(0, 5).toString()).toBe('%PDF-');
    expect(sha(pdf1)).toBe(sha(pdf2));
    expect(sha(pdf1)).toBe(fixture('emp201-capture.pdf.sha256').trim());
  });
});
