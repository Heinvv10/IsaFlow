/**
 * normaliseXlsx / normaliseXlsxSheets against hostile workbooks (budgets P2 PR-B round 1):
 *   - SEC-H1: workbook.xml's <sheets> list is size-capped before any regex reads it (round 2:
 *     only that list, SEC2-L1), the rels are scanned element by element, and the tag and attribute
 *     regexes are bounded, so a run of unclosed `<sheet ` or `<Relationship ` tags costs linear time;
 *   - BRK-H2: shared strings are capped on their own (inflated bytes and entry count), and several
 *     sheets come out of ONE pass (one shared-strings part, one budget);
 *   - QA-6: a corrupt zip (or a corrupt entry) that starts with PK is malformed (a 400), not a crash;
 *   - QA-M2: a named sheet whose rels target is absolute (`/xl/worksheets/…`, Google Sheets and
 *     openpyxl) is read; any other absolute target stays refused.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { normaliseXlsx, normaliseXlsxSheets } from '@/lib/xlsxNormalise';
import { SpreadsheetMalformedError, SpreadsheetRefusedError, SpreadsheetTooLargeError } from '@/lib/spreadsheetErrors';

const MB = 1024 * 1024;
/** Generous on a loaded box: the unbounded regexes take minutes on these inputs. */
const FAST_MS = 2000;

async function threeSheets(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('First').addRow(['first-marker']);
  wb.addWorksheet('Budget').addRow(['budget-marker']);
  wb.addWorksheet('_meta', { state: 'hidden' }).addRow(['meta-marker']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function replaced(src: Buffer, parts: Record<string, string>): Promise<Buffer> {
  const zip = await JSZip.loadAsync(src);
  for (const [path, body] of Object.entries(parts)) zip.file(path, body);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const part = async (buf: Buffer, path: string) => (await JSZip.loadAsync(buf)).file(path)!.async('string');

/** Run `fn`, answer how long it took and what it threw (or null). */
async function timed(fn: () => Promise<unknown>): Promise<{ ms: number; err: unknown }> {
  const t0 = Date.now();
  try {
    await fn();
    return { ms: Date.now() - t0, err: null };
  } catch (err) {
    return { ms: Date.now() - t0, err };
  }
}

describe('SEC-H1: no regex backtracking on workbook.xml or its rels', () => {
  const unclosed = (tag: string, bytes: number) => `<workbook><sheets>${`<${tag} `.repeat(Math.ceil(bytes / (tag.length + 2)))}`;

  it('refuses a ~1 MB workbook.xml of unclosed <sheet tags fast', async () => {
    const bomb = await replaced(await threeSheets(), { 'xl/workbook.xml': unclosed('sheet', MB) });
    for (const run of [() => normaliseXlsx(bomb, 8 * MB), () => normaliseXlsxSheets(bomb, ['_meta'], { maxBytes: 8 * MB })]) {
      const { ms, err } = await timed(run);
      expect(err).toBeInstanceOf(SpreadsheetRefusedError);
      expect(ms).toBeLessThan(FAST_MS);
    }
  }, 60000);

  it('refuses a ~1 MB rels part of unclosed <Relationship tags fast (read element by element, then malformed)', async () => {
    const rels = `<Relationships>${'<Relationship '.repeat(Math.ceil(MB / 14))}`;
    const bomb = await replaced(await threeSheets(), { 'xl/_rels/workbook.xml.rels': rels });
    const { ms, err } = await timed(() => normaliseXlsxSheets(bomb, ['_meta'], { maxBytes: 8 * MB }));
    expect(err).toBeInstanceOf(SpreadsheetRefusedError);
    expect(ms).toBeLessThan(FAST_MS);
  }, 60000);

  it('reads a just-under-cap <sheets> list of unclosed tags, or of tags full of attribute-name runs, in linear time', async () => {
    const runs = `<workbook><sheets>${`<sheet ${'a'.repeat(2030)}/>`.repeat(28)}</sheets></workbook>`;
    for (const xml of [`${unclosed('sheet', 60 * 1024)}</sheets>`, `<workbook><sheets><sheet ${'a'.repeat(60 * 1024)}</sheets>`, runs]) {
      const crafted = await replaced(await threeSheets(), { 'xl/workbook.xml': xml });
      const first = await timed(() => normaliseXlsx(crafted, 8 * MB));
      expect(first.ms).toBeLessThan(FAST_MS);
      const named = await timed(() => normaliseXlsxSheets(crafted, ['_meta'], { maxBytes: 8 * MB }));
      expect(named.ms).toBeLessThan(FAST_MS);
      // These lists are not well-formed XML, so the part scan (round 3) refuses them; the point is the time.
      if (named.err !== null) expect(named.err).toBeInstanceOf(SpreadsheetRefusedError);
    }
  }, 60000);
});

describe('normaliseXlsxSheets: several sheets, one pass', () => {
  it('keeps the named sheets that exist, in the order asked, as sheet1..n', async () => {
    const src = await threeSheets();
    const out = await normaliseXlsxSheets(src, ['_meta', 'Nope', 'Budget'], { maxBytes: MB });
    expect(out.sheets).toEqual(['_meta', 'Budget']);
    expect(await part(out.zip, 'xl/worksheets/sheet1.xml')).toBe(await part(src, 'xl/worksheets/sheet3.xml'));
    expect(await part(out.zip, 'xl/worksheets/sheet2.xml')).toBe(await part(src, 'xl/worksheets/sheet2.xml'));
    expect((await JSZip.loadAsync(out.zip)).file('xl/worksheets/sheet3.xml')).toBeNull();
  });

  it('counts every sheet against one budget', async () => {
    const src = await threeSheets();
    const pad = (n: number) => `<worksheet><sheetData>${' '.repeat(n)}</sheetData></worksheet>`;
    const two = await replaced(src, { 'xl/worksheets/sheet2.xml': pad(0.6 * MB), 'xl/worksheets/sheet3.xml': pad(0.6 * MB) });
    await expect(normaliseXlsxSheets(two, ['Budget'], { maxBytes: MB })).resolves.toMatchObject({ sheets: ['Budget'] });
    await expect(normaliseXlsxSheets(two, ['Budget', '_meta'], { maxBytes: MB })).rejects.toBeInstanceOf(SpreadsheetTooLargeError);
  });

  it('caps shared strings by inflated bytes, apart from the whole budget', async () => {
    const sst = `<sst>${'<si><t>x</t></si>'.repeat(Math.ceil((2 * MB) / 17))}</sst>`;
    const big = await replaced(await threeSheets(), { 'xl/sharedStrings.xml': sst });
    await expect(normaliseXlsxSheets(big, ['Budget'], { maxBytes: 8 * MB })).resolves.toMatchObject({ sheets: ['Budget'] });
    const { ms, err } = await timed(() => normaliseXlsxSheets(big, ['Budget'], { maxBytes: 8 * MB, maxSharedStringsBytes: MB }));
    expect(err).toBeInstanceOf(SpreadsheetTooLargeError);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('caps shared strings by entry count', async () => {
    const sst = `<sst>${'<si><t>x</t></si>'.repeat(5000)}${'<si/>'.repeat(10)}</sst>`;
    const many = await replaced(await threeSheets(), { 'xl/sharedStrings.xml': sst });
    await expect(normaliseXlsxSheets(many, ['Budget'], { maxBytes: MB, maxSharedStrings: 5010 })).resolves.toMatchObject({ sheets: ['Budget'] });
    await expect(normaliseXlsxSheets(many, ['Budget'], { maxBytes: MB, maxSharedStrings: 5009 })).rejects.toBeInstanceOf(SpreadsheetTooLargeError);
  });
});

describe('QA-6: a corrupt zip that starts with PK is malformed, not a crash', () => {
  it('a truncated zip', async () => {
    const src = await threeSheets();
    const cut = src.subarray(0, Math.floor(src.length / 2));
    await expect(normaliseXlsx(cut, MB)).rejects.toBeInstanceOf(SpreadsheetMalformedError);
    await expect(normaliseXlsxSheets(cut, ['Budget'], { maxBytes: MB })).rejects.toBeInstanceOf(SpreadsheetMalformedError);
  });

  it('a zip whose entry data is corrupt', async () => {
    const zip = new JSZip();
    zip.file('xl/workbook.xml', `<workbook>${'<x/>'.repeat(5000)}</workbook>`);
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const data = buf.indexOf(Buffer.from('xl/workbook.xml')) + 'xl/workbook.xml'.length;
    for (let i = data + 4; i < data + 60; i++) buf[i] = 0xff; // the deflate stream, not the headers
    await expect(normaliseXlsx(buf, MB)).rejects.toBeInstanceOf(SpreadsheetMalformedError);
  });
});

describe('QA-M2: absolute rels targets for a named sheet', () => {
  async function retarget(src: Buffer, name: string, target: string): Promise<Buffer> {
    const zip = await JSZip.loadAsync(src);
    const workbook = await zip.file('xl/workbook.xml')!.async('string');
    const relId = /r:id="([^"]+)"/.exec(new RegExp(`<sheet\\b[^>]*name="${name}"[^>]*>`).exec(workbook)![0])![1]!;
    const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
    const relTag = new RegExp(`<Relationship\\b[^>]*Id="${relId}"[^>]*>`).exec(rels)![0];
    zip.file('xl/_rels/workbook.xml.rels', rels.replace(relTag, relTag.replace(/Target="[^"]*"/, `Target="${target}"`)));
    zip.file('xl/evil.xml', 'x'.repeat(2 * MB));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  it('reads /xl/worksheets/<file>.xml (what Google Sheets and openpyxl write)', async () => {
    const src = await threeSheets();
    const out = await normaliseXlsxSheets(await retarget(src, '_meta', '/xl/worksheets/sheet3.xml'), ['_meta'], { maxBytes: MB });
    expect(out.sheets).toEqual(['_meta']);
    expect(await part(out.zip, 'xl/worksheets/sheet1.xml')).toBe(await part(src, 'xl/worksheets/sheet3.xml'));
  });

  it.each([
    '/xl/evil.xml', '/etc/passwd.xml', '//xl/worksheets/sheet3.xml', '/xl/worksheets/../evil.xml',
    '/xl/worksheets/sub/sheet3.xml', '/worksheets/sheet3.xml', '/XL/worksheets/sheet3.xml',
  ])('still refuses %s, without reading it', async (target) => {
    const out = await normaliseXlsxSheets(await retarget(await threeSheets(), '_meta', target), ['_meta', 'Budget'], { maxBytes: MB });
    expect(out.sheets).toEqual(['Budget']);
  });
});
