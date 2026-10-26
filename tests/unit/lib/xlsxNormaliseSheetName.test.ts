/**
 * normaliseXlsxSheets with one sheet name (the budget import reads `Budget`, `_base` and the hidden `_meta`).
 * The named sheet is resolved through workbook.xml's `r:id` and the workbook rels; only a plain
 * relative `worksheets/<file>.xml` target (or `/xl/worksheets/<file>.xml`, xlsxNormaliseHostile) is
 * taken, so a crafted rels entry (`..`, another absolute path, a part outside xl/worksheets/) is
 * refused before anything is read. Without a name the
 * first sheet is kept, as before. Every read counts against the same inflate budget.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { normaliseXlsx, normaliseXlsxSheets } from '@/lib/xlsxNormalise';
import { SpreadsheetTooLargeError } from '@/lib/spreadsheetErrors';

const MB = 1024 * 1024;

/** The one named sheet's normalised zip, or null when it is not read. */
async function named(buf: Buffer, maxBytes: number, name: string): Promise<Buffer | null> {
  const out = await normaliseXlsxSheets(buf, [name], { maxBytes });
  return out.sheets.length === 1 ? out.zip : null;
}

/** Sheets First, Budget, hidden _meta, each with its own marker value. */
async function threeSheets(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('First').addRow(['first-marker']);
  wb.addWorksheet('Budget').addRow(['budget-marker']);
  wb.addWorksheet('_meta', { state: 'hidden' }).addRow(['meta-marker']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const part = async (buf: Buffer, path: string) => (await JSZip.loadAsync(buf)).file(path)!.async('string');

/** The original part kept as the normalised zip's sheet. */
async function keptSheet(out: Buffer | null): Promise<string> {
  expect(out).not.toBeNull();
  return part(out!, 'xl/worksheets/sheet1.xml');
}

/** `src` with the rels target of the sheet called `name` replaced, and extra parts added. */
async function retarget(src: Buffer, name: string, target: string, extra: Record<string, string> = {}): Promise<Buffer> {
  const zip = await JSZip.loadAsync(src);
  const workbook = await zip.file('xl/workbook.xml')!.async('string');
  const tag = new RegExp(`<sheet\\b[^>]*name="${name}"[^>]*>`).exec(workbook)![0];
  const relId = /r:id="([^"]+)"/.exec(tag)![1]!;
  const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const relTag = new RegExp(`<Relationship\\b[^>]*Id="${relId}"[^>]*>`).exec(rels)![0];
  zip.file('xl/_rels/workbook.xml.rels', rels.replace(relTag, relTag.replace(/Target="[^"]*"/, `Target="${target}"`)));
  for (const [path, body] of Object.entries(extra)) zip.file(path, body);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('normaliseXlsxSheets(buf, [sheetName])', () => {
  it('keeps the named sheet, a hidden one included', async () => {
    const src = await threeSheets();
    const meta = await keptSheet(await named(src, MB, '_meta'));
    expect(meta).toBe(await part(src, 'xl/worksheets/sheet3.xml'));
    const budget = await keptSheet(await named(src, MB, 'Budget'));
    expect(budget).toBe(await part(src, 'xl/worksheets/sheet2.xml'));
  });

  it('answers null for a name the workbook does not have', async () => {
    expect(await named(await threeSheets(), MB, 'Nope')).toBeNull();
  });

  it('without a name keeps the first sheet, as before', async () => {
    const src = await threeSheets();
    expect(await keptSheet(await normaliseXlsx(src, MB))).toBe(await part(src, 'xl/worksheets/sheet1.xml'));
    // The pre-existing fallback still applies when the rels do not resolve the first sheet.
    const unresolved = await retarget(src, 'First', 'worksheets/missing.xml');
    expect(await keptSheet(await normaliseXlsx(unresolved, MB))).toBe(await part(src, 'xl/worksheets/sheet1.xml'));
  });

  // Each target would resolve (by the first-sheet rule) to an existing 2 MB part: reading it would
  // throw past the 1 MB budget, so `null` proves the part was refused before it was read. (JSZip
  // folds `..` out of entry names when it stores them, so a `..` target cannot name a stored part;
  // it is refused anyway.)
  const big = 'x'.repeat(2 * MB);
  it.each([
    ['an absolute path', '/xl/evil.xml'],
    ['a part outside xl/worksheets/', 'evil.xml'],
    ['a ./ part outside xl/worksheets/', './evil.xml'],
    ['a parent segment', '../xl/evil.xml'],
    ['a parent segment inside worksheets/', 'worksheets/../evil.xml'],
    ['a nested folder', 'worksheets/sub/evil.xml'],
    ['a backslash path', 'worksheets\\..\\evil.xml'],
    ['shared strings', 'sharedStrings.xml'],
  ])('refuses a named sheet whose rels target is %s, without reading it', async (_label, target) => {
    const crafted = await retarget(await threeSheets(), '_meta', target, { 'xl/evil.xml': big, 'xl/worksheets/sub/evil.xml': big, 'xl/worksheets\\..\\evil.xml': big });
    expect(await named(crafted, MB, '_meta')).toBeNull();
    expect(await named(crafted, MB, 'Budget')).not.toBeNull();
  });

  it('still counts a named sheet against the inflate budget', async () => {
    const zip = await JSZip.loadAsync(await threeSheets());
    zip.file('xl/worksheets/sheet3.xml', `<worksheet><sheetData>${' '.repeat(2 * MB)}</sheetData></worksheet>`);
    const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await expect(named(bomb, MB, '_meta')).rejects.toBeInstanceOf(SpreadsheetTooLargeError);
    expect(await named(bomb, MB, 'Budget')).not.toBeNull();
  });
});
