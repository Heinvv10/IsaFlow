/**
 * Budgets P2 PR-B round 4, U8: `readerInput` feeds ExcelJS the normalised zip in pieces (N1), and
 * ExcelJS decodes each piece on its own (a TextDecoder without `stream: true`), so a multi-byte
 * UTF-8 character cut across two pieces came back as U+FFFD (breaker r4: 'Société Générale' and
 * 'Fuel ⛽ 🚚' each lost a row in 6 000). Every importer reading through it was hit. Here a 2-, 3-
 * and 4-byte character is placed EXACTLY across a piece boundary of the normalised zip (a comment
 * in styles.xml, which precedes the shared strings, shifts it there), and each must come back
 * intact through xlsxBufferToCsv and through the budget reader.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { normaliseXlsx, readerInput } from '@/lib/xlsxNormalise';
import { READ_CHUNK_BYTES } from '@/lib/xlsxXmlScan';
import { xlsxBufferToCsv } from '@/lib/xlsxToCsv';
import { readBudgetWorkbook, type SheetRow } from '@/modules/accounting/services/budgets/budgetImportParse';

const MB = 1024 * 1024;

/** A workbook with Budget, _meta and _base sheets whose Budget!A2 is `text`. */
async function workbook(text: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Budget');
  ws.addRow(['Account code', 'Name']);
  ws.addRow([text, 'x']);
  wb.addWorksheet('_meta', { state: 'hidden' }).addRow(['versionId', 'x']);
  wb.addWorksheet('_base', { state: 'hidden' }).addRow(['Account code']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function withStylesComment(file: Buffer, length: number): Promise<Buffer> {
  const zip = await JSZip.loadAsync(file);
  const styles = await zip.file('xl/styles.xml')!.async('string');
  const at = styles.indexOf('?>') + 2;
  zip.file('xl/styles.xml', `${styles.slice(0, at)}<!--${'x'.repeat(length)}-->${styles.slice(at)}`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * `file` with styles.xml padded so the first byte of `char` in the normalised zip sits one byte
 * before a READ_CHUNK_BYTES boundary: the character is split across two pieces unless the pieces
 * are cut at a character boundary.
 */
async function straddling(file: Buffer, char: string): Promise<Buffer> {
  const bytes = Buffer.from(char);
  const offset = async (f: Buffer) => (await normaliseXlsx(f, 80 * MB))!.indexOf(bytes);
  const base = await offset(await withStylesComment(file, 0));
  let target = Math.ceil((base + 1) / READ_CHUNK_BYTES) * READ_CHUNK_BYTES - 1;
  if (target - base < 1) target += READ_CHUNK_BYTES;
  const padded = await withStylesComment(file, target - base);
  const at = await offset(padded);
  expect(at).toBe(target); // the character really straddles the boundary
  expect(Math.floor(at / READ_CHUNK_BYTES)).not.toBe(Math.floor((at + bytes.length - 1) / READ_CHUNK_BYTES));
  return padded;
}

const CASES: Array<[string, string]> = [['2-byte é', 'é'], ['3-byte ⛽', '⛽'], ['4-byte 🚚', '🚚']];

describe('U8: no character is split across the reader\'s pieces', () => {
  it('100 000 é in one shared string (200 kB with no > in it) comes back whole, through xlsxBufferToCsv and the budget reader', async () => {
    const text = 'é'.repeat(100_000);
    const file = await workbook(text);
    expect((await xlsxBufferToCsv(file)).split('\n')[1]).toBe(`${text},x`);
    expect((await readBudgetWorkbook(file)).budget[1]!.cells[0]).toBe(text);
  });

  it.each(CASES)('%s, through xlsxBufferToCsv', async (_label, char) => {
    const text = `Société ${char} Générale`;
    const csv = await xlsxBufferToCsv(await straddling(await workbook(text), char));
    expect(csv.split('\n')[1]).toBe(`${text},x`);
  });

  it.each(CASES)('%s, through the budget reader', async (_label, char) => {
    const text = `Fuel ${char} 01`;
    const wb = await readBudgetWorkbook(await straddling(await workbook(text), char));
    expect(wb.budget.map((r: SheetRow) => r.cells[0])).toEqual(['Account code', text]);
  });

  it.each([
    ['a > every few characters (cut after a >)', ['🚚', 'é', '⛽', 'a', '>']],
    ['no > at all, one long text (cut at a character start)', ['🚚', 'é', '⛽', 'a']],
  ])('every piece ends on a character boundary, near full size and never past READ_CHUNK_BYTES: %s', async (_label, chars) => {
    const zip = Buffer.from(Array.from({ length: 300_000 }, (_, i) => chars[i % chars.length]!).join(''));
    expect(zip.toString('utf8')).not.toContain('\uFFFD');
    const pieces: Buffer[] = [];
    for await (const piece of readerInput(zip)) pieces.push(piece as Buffer);
    expect(Buffer.concat(pieces).equals(zip)).toBe(true);
    expect(pieces.length).toBeLessThan(zip.length / (READ_CHUNK_BYTES / 2));
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(READ_CHUNK_BYTES);
      expect(p.toString('utf8')).not.toContain('\uFFFD');
    }
  });
});
